import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { MongoClient, Db, ObjectId } from "mongodb";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";

const apiEnvPath = path.resolve(__dirname, ".env");
const rootEnvPath = path.resolve(__dirname, "..", ".env");

for (const envPath of [apiEnvPath, rootEnvPath]) {
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
    }
}

dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const allowedEmailRaw = process.env.ALLOWED_EMAILS || "";
const ALLOWED_EMAILS = allowedEmailRaw
    .split(/[\n,]+/)
    .map((e) => e.replace(/^['\"]|['\"]$/g, "").trim().toLowerCase())
    .filter(Boolean);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || "");

let db: Db;

async function connectDb() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not defined. Please check your .env file.");
    }
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db(process.env.DB_NAME || "final_bites");

    await db.collection("items").createIndex({ name: 1 }, { unique: true });
    await db.collection("ingredients").createIndex({ name: 1 }, { unique: true });
    await db.collection("sales").createIndex({ soldAt: -1 });
    await db.collection("purchases").createIndex({ boughtAt: -1 });
    await db.collection("ledger").createIndex({ at: -1 });
    console.log("Connected to MongoDB:", db.databaseName);
}

const app = express();
app.use(cors());
app.use(express.json());

let dbReady: Promise<void> | null = null;
async function ensureDbConnected() {
    if (!dbReady) {
        dbReady = connectDb();
    }
    await dbReady;
}

// ---------------------------------------------------------------- auth -----
interface AuthedRequest extends Request { user?: { email: string; name: string }; }

app.post("/api/auth/google", async (req: Request, res: Response) => {
    try {
        const { idToken } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        if (!payload?.email) return res.status(401).send("No email on token");
        const email = payload.email.toLowerCase();
        if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
            console.error("Whitelist rejection:", { email, allowedEmails: ALLOWED_EMAILS });
            return res.status(403).send(`Email not authorized for this till: ${email}`);
        }
        const token = jwt.sign({ email, name: payload.name || email }, JWT_SECRET, { expiresIn: "12h" });
        res.json({ token, email, name: payload.name || email });
    } catch (e) {
        res.status(401).send("Invalid Google token");
    }
});

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
    if (!token) return res.status(401).send("Missing token");
    try {
        req.user = jwt.verify(token, JWT_SECRET) as { email: string; name: string };
        next();
    } catch {
        res.status(401).send("Invalid or expired token");
    }
}

// ---------------------------------------------------------- write API -----
const write = express.Router();
write.use(requireAuth);

write.post("/item", async (req: AuthedRequest, res) => {
    const { name, price, category, recipe } = req.body as {
        name: string; price: number; category?: string; recipe: { ingredientId: string; qty: number }[];
    };
    await db.collection("items").updateOne(
        { name },
        { $set: { name, price, category: category || "general", recipe: recipe || [] } },
        { upsert: true }
    );
    res.json({ ok: true });
});

write.post("/ingredient", async (req: AuthedRequest, res) => {
    const { name, unit, initialStock, reorderLevel } = req.body as {
        name: string; unit: string; initialStock?: number; reorderLevel?: number;
    };
    await db.collection("ingredients").updateOne(
        { name },
        { $setOnInsert: { name, unit, stock: initialStock || 0, avgCost: 0, reorderLevel: reorderLevel || 0 } },
        { upsert: true }
    );
    res.json({ ok: true });
});

write.post("/purchase", async (req: AuthedRequest, res) => {
    const { ingredientId, qty, unitCost, supplier } = req.body as {
        ingredientId: string; qty: number; unitCost: number; supplier?: string;
    };
    const ing = await db.collection("ingredients").findOne({ _id: new ObjectId(ingredientId) });
    if (!ing) return res.status(404).send("Ingredient not found");

    const total = qty * unitCost;
    const newStock = ing.stock + qty;
    const newAvgCost = newStock > 0 ? ((ing.stock * ing.avgCost) + total) / newStock : unitCost;

    await db.collection("ingredients").updateOne(
        { _id: ing._id },
        { $set: { stock: newStock, avgCost: newAvgCost } }
    );

    const at = new Date();
    const purchase = { ingredientId: ing._id, ingredientName: ing.name, qty, unitCost, total, supplier: supplier || "", boughtAt: at, boughtBy: req.user!.email };
    const { insertedId } = await db.collection("purchases").insertOne(purchase);

    await db.collection("ledger").insertOne({
        type: "purchase", ref: insertedId, description: `Bought ${qty} ${ing.unit} ${ing.name}`,
        cashDelta: -total, stockValueDelta: +total, at, by: req.user!.email,
    });

    res.json({ ok: true, purchaseId: insertedId, newStock, newAvgCost });
});

write.post("/sale", async (req: AuthedRequest, res) => {
    const { itemId, qty } = req.body as { itemId: string; qty: number };
    const item = await db.collection("items").findOne({ _id: new ObjectId(itemId) });
    if (!item) return res.status(404).send("Item not found");

    const ingredientDocs: Record<string, any> = {};
    for (const line of item.recipe || []) {
        const ing = await db.collection("ingredients").findOne({ _id: new ObjectId(line.ingredientId) });
        if (!ing) return res.status(404).send(`Ingredient missing for recipe: ${line.ingredientId}`);
        const needed = line.qty * qty;
        if (ing.stock < needed) return res.status(409).send(`Not enough ${ing.name} in stock`);
        ingredientDocs[line.ingredientId] = { ing, needed };
    }

    let cost = 0;
    for (const key of Object.keys(ingredientDocs)) {
        const { ing, needed } = ingredientDocs[key];
        cost += needed * ing.avgCost;
        await db.collection("ingredients").updateOne({ _id: ing._id }, { $inc: { stock: -needed } });
    }

    const total = item.price * qty;
    const profit = total - cost;
    const at = new Date();
    const sale = { itemId: item._id, itemName: item.name, qty, unitPrice: item.price, total, cost, profit, soldAt: at, soldBy: req.user!.email };
    const { insertedId } = await db.collection("sales").insertOne(sale);

    await db.collection("ledger").insertOne({
        type: "sale", ref: insertedId, description: `Sold ${qty} x ${item.name}`,
        cashDelta: +total, stockValueDelta: -cost, at, by: req.user!.email,
    });

    res.json({ ok: true, saleId: insertedId, total, cost, profit });
});

app.use("/api/write", write);

// ----------------------------------------------------------- read API -----
const read = express.Router();
read.use(requireAuth);

read.get("/items", async (_req, res) => {
    await ensureDbConnected();
    res.json(await db.collection("items").find().sort({ name: 1 }).toArray());
});

read.get("/ingredients", async (_req, res) => {
    await ensureDbConnected();
    res.json(await db.collection("ingredients").find().sort({ name: 1 }).toArray());
});

read.get("/sales", async (req, res) => {
    await ensureDbConnected();
    const { from, to } = req.query as { from?: string; to?: string };
    const filter: any = {};
    if (from || to) filter.soldAt = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
    res.json(await db.collection("sales").find(filter).sort({ soldAt: -1 }).limit(500).toArray());
});

read.get("/purchases", async (req, res) => {
    await ensureDbConnected();
    const { from, to } = req.query as { from?: string; to?: string };
    const filter: any = {};
    if (from || to) filter.boughtAt = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
    res.json(await db.collection("purchases").find(filter).sort({ boughtAt: -1 }).limit(500).toArray());
});

read.get("/ledger", async (req, res) => {
    await ensureDbConnected();
    const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 1000);
    res.json(await db.collection("ledger").find().sort({ at: -1 }).limit(limit).toArray());
});

read.get("/summary", async (_req, res) => {
    await ensureDbConnected();
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const salesToday = await db.collection("sales").find({ soldAt: { $gte: startOfDay } }).toArray();
    const revenue = salesToday.reduce((s, x) => s + x.total, 0);
    const cost = salesToday.reduce((s, x) => s + x.cost, 0);
    const profit = revenue - cost;
    const itemsSold = salesToday.reduce((s, x) => s + x.qty, 0);

    const allIngredients = await db.collection("ingredients").find().toArray();
    const lowStock = allIngredients
        .filter((ing) => ing.stock <= ing.reorderLevel)
        .map((ing) => ({ name: ing.name, stock: ing.stock, unit: ing.unit }));

    res.json({ revenue, cost, profit, itemsSold, lowStock });
});

read.get("/export", async (req, res) => {
    await ensureDbConnected();
    const type = String(req.query.type || "sales");
    const allowed = new Set(["sales", "purchases", "ledger", "items", "ingredients"]);
    if (!allowed.has(type)) {
        return res.status(400).send("Unsupported export type");
    }

    const collectionMap: Record<string, string> = {
        sales: "sales",
        purchases: "purchases",
        ledger: "ledger",
        items: "items",
        ingredients: "ingredients",
    };

    const records = await db.collection(collectionMap[type]).find().sort({ _id: -1 }).limit(5000).toArray();
    if (!records.length) {
        return res.status(400).send(`No ${type} available to export.`);
    }

    const normalized = records.map((record: any) => {
        const flat: Record<string, any> = {};
        for (const [key, value] of Object.entries(record)) {
            if (value instanceof Date) flat[key] = value.toISOString();
            else if (value && typeof value === "object" && "toHexString" in value) flat[key] = value.toString();
            else if (value !== undefined) flat[key] = value;
        }
        return flat;
    });

    const headers = Array.from(new Set(normalized.flatMap((row) => Object.keys(row))));

    const escapeCsv = (value: any) => {
        const text = value == null ? "" : String(value).replace(/\r?\n/g, " ");
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const csvLines = [headers.map(escapeCsv).join(",")];
    for (const row of normalized) {
        csvLines.push(headers.map((header) => escapeCsv(row[header])).join(","));
    }

    const fileName = `${type}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(csvLines.join("\n"));
});

app.use("/api/read", read);

if (require.main === module) {
    connectDb().then(() => {
        app.listen(PORT, () => console.log(`Final Bites Till API running on port ${PORT}`));
    }).catch((error) => {
        console.error("Database connection failed:", error);
        process.exit(1);
    });
}

export default app;