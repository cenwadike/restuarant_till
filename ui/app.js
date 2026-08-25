"use strict";
// ---------------------------------------------------------------------------
// Campus Bites Till — frontend logic (vanilla TS, no framework, no deps).
// Compile with: tsc app.ts --target ES2020 --module ES2020  ->  app.js
// Talks to the backend's two APIs:
//   POST /api/write/*   (create sales, purchases, items, ingredients)
//   GET  /api/read/*    (menu, stock, summaries, exports)
// ---------------------------------------------------------------------------
// ---- config ---------------------------------------------------------------
const API_BASE = "http://localhost:8080";
const GOOGLE_CLIENT_ID = window.GOOGLE_CLIENT_ID || "";
// ---- state ------------------------------------------------------------------
let authToken = null;
let items = [];
let ingredients = [];
let ticket = [];
let selectedIngredient = null;
// ---- demo mode ----------------------------------------------------------------
const DEMO_MODE_ENABLED = false;
function isDemoMode() {
    return DEMO_MODE_ENABLED && new URLSearchParams(location.search).get("demo") === "1";
}
const DEMO_ITEMS = [
    { _id: "d-i1", name: "Veg Burger", price: 60, category: "burgers", recipe: [] },
    { _id: "d-i2", name: "Cheese Sandwich", price: 50, category: "sandwiches", recipe: [] },
    { _id: "d-i3", name: "Cold Coffee", price: 50, category: "drinks", recipe: [] },
    { _id: "d-i4", name: "Paneer Roll", price: 70, category: "rolls", recipe: [] },
    { _id: "d-i5", name: "French Fries", price: 40, category: "sides", recipe: [] },
    { _id: "d-i6", name: "Masala Chai", price: 15, category: "drinks", recipe: [] },
];
const DEMO_INGREDIENTS = [
    { _id: "d-g1", name: "Burger bun", unit: "pcs", stock: 8, avgCost: 4, reorderLevel: 20 },
    { _id: "d-g2", name: "Potato", unit: "kg", stock: 14, avgCost: 25, reorderLevel: 5 },
    { _id: "d-g3", name: "Paneer", unit: "kg", stock: 1.2, avgCost: 280, reorderLevel: 3 },
    { _id: "d-g4", name: "Milk", unit: "l", stock: 9, avgCost: 55, reorderLevel: 4 },
];
let demoLedger = [
    { description: "Sold 2 x Veg Burger", cashDelta: 120, at: new Date() },
    { description: "Bought 10 kg Potato", cashDelta: -350, at: new Date() },
    { description: "Sold 1 x Cold Coffee", cashDelta: 50, at: new Date() },
];
function demoGet(path) {
    const base = path.split("?")[0];
    if (base === "items")
        return DEMO_ITEMS;
    if (base === "ingredients")
        return DEMO_INGREDIENTS;
    if (base === "summary") {
        const revenue = demoLedger.filter((l) => l.cashDelta > 0).reduce((s, l) => s + l.cashDelta, 0);
        const cost = Math.round(revenue * 0.42 * 100) / 100;
        const lowStock = DEMO_INGREDIENTS.filter((i) => i.stock <= i.reorderLevel).map((i) => ({
            name: i.name,
            stock: i.stock,
            unit: i.unit,
        }));
        return { revenue, cost, profit: revenue - cost, itemsSold: demoLedger.length * 2, lowStock };
    }
    if (base === "ledger")
        return demoLedger.slice(0, 15);
    return [];
}
function demoPost(path, body) {
    if (path === "item") {
        DEMO_ITEMS.push({ _id: `d-i${DEMO_ITEMS.length + 1}`, ...body });
        return { ok: true };
    }
    if (path === "ingredient") {
        DEMO_INGREDIENTS.push({
            _id: `d-g${DEMO_INGREDIENTS.length + 1}`,
            name: body.name,
            unit: body.unit,
            stock: body.initialStock || 0,
            avgCost: 0,
            reorderLevel: body.reorderLevel || 0,
        });
        return { ok: true };
    }
    if (path === "sale") {
        const item = DEMO_ITEMS.find((i) => i._id === body.itemId);
        if (item)
            demoLedger.unshift({
                description: `Sold ${body.qty} x ${item.name}`,
                cashDelta: item.price * body.qty,
                at: new Date(),
            });
        return { ok: true };
    }
    if (path === "purchase") {
        const ing = DEMO_INGREDIENTS.find((i) => i._id === body.ingredientId);
        if (ing) {
            ing.stock += body.qty;
            demoLedger.unshift({
                description: `Bought ${body.qty} ${ing.unit} ${ing.name}`,
                cashDelta: -(body.qty * body.unitCost),
                at: new Date(),
            });
        }
        return { ok: true };
    }
    return { ok: true };
}
// ---- small DOM helpers -------------------------------------------------------
const $ = (id) => document.getElementById(id);
function toast(msg, isError = false) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    el.classList.toggle("error", isError);
    setTimeout(() => el.classList.add("hidden"), 2600);
}
const money = (n) => "₦" + n.toFixed(2);
// ---- auth ---------------------------------------------------------------------
async function handleCredentialResponse(response) {
    try {
        const res = await fetch(`${API_BASE}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: response.credential }),
        });
        if (!res.ok)
            throw new Error(await res.text());
        const data = await res.json();
        authToken = data.token;
        localStorage.setItem("cb_token", data.token);
        localStorage.setItem("cb_name", data.name);
        showSignedIn(data.name);
        await bootstrap();
    }
    catch (e) {
        toast("Sign-in failed — is your email allow-listed?", true);
    }
}
window.handleCredentialResponse = handleCredentialResponse;
function showSignedIn(name) {
    $("googleBtn").classList.add("hidden");
    $("userChip").classList.remove("hidden");
    $("userName").textContent = name;
    $("app").classList.remove("hidden");
}
function signOut() {
    authToken = null;
    localStorage.removeItem("cb_token");
    localStorage.removeItem("cb_name");
    location.reload();
}
function authHeaders() {
    return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}
// ---- api helpers ----------------------------------------------------------------
async function apiGet(path) {
    if (isDemoMode())
        return demoGet(path);
    const res = await fetch(`${API_BASE}/api/read/${path}`, { headers: authHeaders() });
    if (!res.ok)
        throw new Error(await res.text());
    return res.json();
}
async function apiPost(path, body) {
    if (isDemoMode())
        return demoPost(path, body);
    const res = await fetch(`${API_BASE}/api/write/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(await res.text());
    return res.json();
}
// ---- bootstrap ----------------------------------------------------------------
async function bootstrap() {
    const [itemsRes, ingredientsRes] = await Promise.all([apiGet("items"), apiGet("ingredients")]);
    items = itemsRes;
    ingredients = ingredientsRes;
    renderQuickGrid();
    renderStockGrid();
    renderManageItemGrid();
    await refreshReports();
}
// ---- tabs -----------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        const tabEl = tab;
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        tabEl.classList.add("active");
        $(`tab-${tabEl.dataset.tab}`).classList.add("active");
        if (tabEl.dataset.tab === "reports")
            refreshReports();
    });
});
// ---- MENU & STOCK SETUP ---------------------------------------------------------
function renderManageItemGrid() {
    const grid = $("manageItemGrid");
    if (!grid)
        return;
    grid.innerHTML = "";
    if (!items.length) {
        grid.innerHTML = `<p class="muted">No menu items created yet.</p>`;
        return;
    }
    items.forEach((it) => {
        const tile = document.createElement("div");
        tile.className = "quick-tile";
        tile.innerHTML = `
      <span class="qt-name">${it.name}</span>
      <span class="qt-meta">${money(it.price)} · ${it.category || "General"}</span>
    `;
        grid.appendChild(tile);
    });
}
$("createItemForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = $("newItemName");
    const priceInput = $("newItemPrice");
    const catInput = $("newItemCategory");
    const btn = $("saveItemBtn");
    const name = nameInput.value.trim();
    const price = parseFloat(priceInput.value);
    const category = catInput.value.trim() || "general";
    if (!name || isNaN(price))
        return;
    btn.disabled = true;
    try {
        await apiPost("item", { name, price, category, recipe: [] });
        toast(`Added "${name}" to menu.`);
        e.target.reset();
        items = await apiGet("items");
        renderQuickGrid();
        renderManageItemGrid();
    }
    catch (err) {
        toast("Error saving item — check backend connection.", true);
    }
    finally {
        btn.disabled = false;
    }
});
$("createIngredientForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = $("newIngName");
    const unitInput = $("newIngUnit");
    const stockInput = $("newIngStock");
    const reorderInput = $("newIngReorder");
    const btn = $("saveIngBtn");
    const name = nameInput.value.trim();
    const unit = unitInput.value.trim();
    const initialStock = parseFloat(stockInput.value) || 0;
    const reorderLevel = parseFloat(reorderInput.value) || 0;
    if (!name || !unit)
        return;
    btn.disabled = true;
    try {
        await apiPost("ingredient", { name, unit, initialStock, reorderLevel });
        toast(`Added ingredient "${name}".`);
        e.target.reset();
        ingredients = await apiGet("ingredients");
        renderStockGrid();
    }
    catch (err) {
        toast("Error saving ingredient.", true);
    }
    finally {
        btn.disabled = false;
    }
});
// ---- SELL: search + suggestions -------------------------------------------------
function renderQuickGrid() {
    const grid = $("itemGrid");
    grid.innerHTML = "";
    items.slice(0, 12).forEach((it) => {
        const tile = document.createElement("button");
        tile.className = "quick-tile";
        tile.innerHTML = `<span class="qt-name">${it.name}</span><span class="qt-meta">${money(it.price)}</span>`;
        tile.onclick = () => addToTicket(it);
        grid.appendChild(tile);
    });
}
function wireSearch(inputId, suggestId, source, onPick) {
    const input = $(inputId);
    const list = $(suggestId);
    input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        list.innerHTML = "";
        if (!q) {
            list.classList.add("hidden");
            return;
        }
        const matches = source().filter((s) => s.label.toLowerCase().includes(q)).slice(0, 8);
        if (!matches.length) {
            list.classList.add("hidden");
            return;
        }
        matches.forEach((m) => {
            const row = document.createElement("div");
            row.className = "suggest-item";
            row.innerHTML = `<span>${m.label}</span><span class="s-sub">${m.sub}</span>`;
            row.onclick = () => {
                onPick(m.id);
                input.value = "";
                list.classList.add("hidden");
            };
            list.appendChild(row);
        });
        list.classList.remove("hidden");
    });
    document.addEventListener("click", (e) => {
        if (!e.target.closest(`#${inputId}, #${suggestId}`))
            list.classList.add("hidden");
    });
}
wireSearch("itemSearch", "itemSuggest", () => items.map((i) => ({ id: i._id, label: i.name, sub: money(i.price) })), (id) => {
    const it = items.find((i) => i._id === id);
    if (it)
        addToTicket(it);
});
function addToTicket(item) {
    const line = ticket.find((l) => l.item._id === item._id);
    if (line)
        line.qty += 1;
    else
        ticket.push({ item, qty: 1 });
    renderTicket();
}
function renderTicket() {
    const box = $("ticketLines");
    $("ticketTime").textContent = new Date().toLocaleTimeString();
    if (!ticket.length) {
        box.innerHTML = `<p class="ticket-empty">No items yet — search and tap to add.</p>`;
    }
    else {
        box.innerHTML = "";
        ticket.forEach((line, idx) => {
            const row = document.createElement("div");
            row.className = "ticket-line";
            row.innerHTML = `
        <span class="tl-name">${line.item.name}</span>
        <span class="tl-qty">
          <button data-act="dec">–</button>${line.qty}<button data-act="inc">+</button>
        </span>
        <span class="tl-price">${money(line.item.price * line.qty)}</span>`;
            row.querySelector('[data-act="inc"]').addEventListener("click", () => {
                line.qty++;
                renderTicket();
            });
            row.querySelector('[data-act="dec"]').addEventListener("click", () => {
                line.qty--;
                if (line.qty <= 0)
                    ticket.splice(idx, 1);
                renderTicket();
            });
            box.appendChild(row);
        });
    }
    const total = ticket.reduce((s, l) => s + l.item.price * l.qty, 0);
    $("ticketTotal").textContent = money(total);
    $("completeSaleBtn").disabled = ticket.length === 0;
}
$("clearTicketBtn").addEventListener("click", () => {
    ticket = [];
    renderTicket();
});
$("completeSaleBtn").addEventListener("click", async () => {
    const btn = $("completeSaleBtn");
    btn.disabled = true;
    try {
        for (const line of ticket) {
            await apiPost("sale", { itemId: line.item._id, qty: line.qty });
        }
        toast("Sale recorded.");
        ticket = [];
        renderTicket();
        ingredients = await apiGet("ingredients");
        renderStockGrid();
        await refreshReports();
    }
    catch (e) {
        toast("Could not record sale — check stock.", true);
    }
    finally {
        btn.disabled = ticket.length === 0;
    }
});
// ---- BUY: search + purchase form -------------------------------------------------
function renderStockGrid() {
    const grid = $("stockGrid");
    grid.innerHTML = "";
    ingredients.slice(0, 12).forEach((ing) => {
        const low = ing.stock <= ing.reorderLevel;
        const tile = document.createElement("button");
        tile.className = "quick-tile" + (low ? " low" : "");
        tile.innerHTML = `<span class="qt-name">${ing.name}</span><span class="qt-meta">${ing.stock} ${ing.unit} on hand</span>`;
        tile.onclick = () => selectIngredient(ing._id);
        grid.appendChild(tile);
    });
}
wireSearch("ingredientSearch", "ingredientSuggest", () => ingredients.map((i) => ({ id: i._id, label: i.name, sub: `${i.stock} ${i.unit}` })), (id) => selectIngredient(id));
function selectIngredient(id) {
    selectedIngredient = ingredients.find((i) => i._id === id) || null;
    if (!selectedIngredient)
        return;
    $("purchaseTarget").textContent = selectedIngredient.name;
    $("purchaseUnit").textContent = `(${selectedIngredient.unit})`;
    $("logPurchaseBtn").disabled = false;
    updatePurchaseTotal();
}
function updatePurchaseTotal() {
    const qty = parseFloat($("purchaseQty").value) || 0;
    const cost = parseFloat($("purchaseCost").value) || 0;
    $("purchaseTotal").textContent = money(qty * cost);
}
$("purchaseQty").addEventListener("input", updatePurchaseTotal);
$("purchaseCost").addEventListener("input", updatePurchaseTotal);
$("purchaseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedIngredient)
        return;
    const qty = parseFloat($("purchaseQty").value);
    const unitCost = parseFloat($("purchaseCost").value);
    const supplier = $("purchaseSupplier").value;
    try {
        await apiPost("purchase", { ingredientId: selectedIngredient._id, qty, unitCost, supplier });
        toast("Purchase logged.");
        document.getElementById("purchaseForm").reset();
        selectedIngredient = null;
        $("purchaseTarget").textContent = "— select an ingredient —";
        $("purchaseUnit").textContent = "";
        $("logPurchaseBtn").disabled = true;
        ingredients = await apiGet("ingredients");
        renderStockGrid();
        await refreshReports();
    }
    catch (e) {
        toast("Could not log purchase.", true);
    }
});
// ---- REPORTS -----------------------------------------------------------------
async function refreshReports() {
    try {
        const summary = await apiGet("summary");
        $("sumRevenue").textContent = money(summary.revenue);
        $("sumCost").textContent = money(summary.cost);
        $("sumProfit").textContent = money(summary.profit);
        $("sumCount").textContent = String(summary.itemsSold);
        const lowBox = $("lowStockList");
        lowBox.innerHTML = summary.lowStock.length
            ? summary.lowStock
                .map((s) => `<div class="row crit"><span>${s.name}</span><span>${s.stock} ${s.unit} left</span></div>`)
                .join("")
            : `<p class="muted">All ingredients above reorder level.</p>`;
        const ledger = await apiGet("ledger?limit=15");
        const ledgerBox = $("ledgerList");
        ledgerBox.innerHTML = ledger.length
            ? ledger
                .map((l) => {
                    const sign = l.cashDelta >= 0 ? "pos" : "neg";
                    return `<div class="row"><span>${new Date(l.at).toLocaleTimeString()} · ${l.description}</span><span class="lg-amt ${sign}">${money(l.cashDelta)}</span></div>`;
                })
                .join("")
            : `<p class="muted">No activity yet.</p>`;
    }
    catch (e) {
        toast("Could not load reports.", true);
    }
}
document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const type = btn.dataset.export;
        const url = `${API_BASE}/api/read/export?type=${type}&token=${encodeURIComponent(authToken || "")}`;
        window.open(url, "_blank");
    });
});
// ---- sign-out + init -----------------------------------------------------------
$("signOutBtn").addEventListener("click", signOut);
window.addEventListener("load", () => {
    if (isDemoMode()) {
        showSignedIn("Demo mode");
        document.title = "Campus Bites — Till (Demo)";
        bootstrap();
        return;
    }
    window.google?.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
    });
    window.google?.accounts.id.renderButton($("googleBtn"), { theme: "filled_black", size: "medium" });
    const savedToken = localStorage.getItem("cb_token");
    const savedName = localStorage.getItem("cb_name");
    if (savedToken && savedName) {
        authToken = savedToken;
        showSignedIn(savedName);
        bootstrap();
    }
});
