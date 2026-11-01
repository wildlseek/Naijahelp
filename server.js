require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const PROVIDERS_FILE = path.join(__dirname, "providers.json");
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v19.0";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || "naijahelp123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "naijahelp2026";
const ADMIN_NUMBERS = (process.env.ADMIN_WHATSAPP_NUMBERS || "").split(",").map(s=>s.trim()).filter(Boolean);

const userLastCategory = new Map();
const adminAddState = new Map();

// --- Helpers ---
function loadProviders() { 
  try { 
    return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); 
  } catch (e) { 
    console.log("No providers.json yet, starting empty"); 
    return []; 
  } 
}
function saveProviders(data) { 
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2)); 
}
function distanceKm(lat1, lon1, lat2, lon2) { 
  const toRad = d => d * Math.PI / 180; 
  const R = 6371; 
  const dLat = toRad(lat2-lat1); 
  const dLon = toRad(lon2-lon1); 
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2; 
  return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
}
function mapsLink(lat, lon) { 
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lon}`)}`; 
}
function searchHelper({ lat, lon, category, radius = 5, limit = 3 }) {
  const all = loadProviders()
    .filter(p => p.category === category)
    .filter(p => p.verificationStatus === "verified")
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map(p => ({ ...p, distanceKm: distanceKm(lat, lon, p.lat, p.lon), mapsUrl: mapsLink(p.lat, p.lon) }))
    .sort((a,b) => a.distanceKm-b.distanceKm);
  let results = all.filter(p => p.distanceKm <= radius).slice(0, limit); 
  let usedRadius = radius;
  if (results.length === 0 && radius < 10) { results = all.filter(p => p.distanceKm <= 10).slice(0, limit); usedRadius = 10; }
  if (results.length === 0 && radius < 20) { results = all.filter(p => p.distanceKm <= 20).slice(0, limit); usedRadius = 20; }
  return { results, usedRadius, totalInCategory: all.length };
}
function formatWhatsAppResults(category, searchResult) {
  const { results, usedRadius } = searchResult; 
  if (results.length === 0) return `No verified ${category} found within 20km.\n\nTry another category or reply MENU.`;
  let reply = `Nearest ${category.toUpperCase()} (${results.length} found within ${usedRadius}km):\n`;
  results.forEach((p,i) => { 
    reply += `\n${i+1}. ${p.name} - ${p.distanceKm.toFixed(1)}km\n${p.address}\n📞 ${p.phone}\n🗺️ ${p.mapsUrl}\n`; 
  });
  reply += `\nReply MENU for other services.`; 
  return reply;
}
function normalizeCategory(text) { 
  text = text.toLowerCase(); 
  if (/hospital|clinic|doctor/.test(text)) return "hospital"; 
  if (/pharm|drug|chemist/.test(text)) return "pharmacy"; 
  if (/mechanic|rewire|car repair|auto/.test(text)) return "mechanic"; 
  if (/vulcanizer|vulcaniser|tyre|tire|pump/.test(text)) return "vulcanizer"; 
  if (/tow/.test(text)) return "towing"; 
  if (/ambulance|emergency|paramedic/.test(text)) return "ambulance"; 
  return null; 
}
function isAdmin(number) { 
  const clean = number.replace(/^\+/,""); 
  return ADMIN_NUMBERS.some(a => clean.endsWith(a.replace(/^\+/,"")) || a.replace(/^\+/,"").endsWith(clean)); 
}

// --- ROUTES ---

// 1. HOMEPAGE - Fixes "Cannot GET /"
app.get("/", (req, res) => {
  const count = loadProviders().length;
  res.send(`
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NaijaHelp</title>
    <style>body{font-family:sans-serif;padding:20px;max-width:600px;margin:auto;text-align:center}
    .ok{color:#25D366;font-weight:bold} a{color:#128C7E;text-decoration:none} .card{border:1px solid #eee;padding:15px;border-radius:10px;margin:10px 0}</style></head>
    <body>
      <h1>NaijaHelp is Live <span class="ok">✅</span></h1>
      <p>Total verified providers: <b>${count}</b></p>
      <div class="card"><b>Webhook:</b> /webhook<br><b>Health:</b> <a href="/health">/health</a><br><b>Admin:</b> <a href="/admin">/admin</a></div>
      <p>Test WhatsApp: +1 (711) 766-8748</p>
      <p style="color:#888;font-size:13px">If you see this, Render is awake. Now send "hi" on WhatsApp.</p>
    </body></html>
  `);
});

app.get("/health", (req,res) => res.json({ ok:true, providers: loadProviders().length, time: new Date().toISOString() }));

app.get("/search", (req,res) => { 
  const lat = Number(req.query.lat); 
  const lon = Number(req.query.lon); 
  const category = String(req.query.category || "").toLowerCase(); 
  const radius = Math.min(Number(req.query.radius || 5), 20); 
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "Valid lat/lon required." }); 
  const { results, usedRadius, totalInCategory } = searchHelper({ lat, lon, category, radius }); 
  res.json({ category, usedRadius, totalInCategory, count: results.length, results }); 
});

app.get("/webhook", (req,res) => { 
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("WEBHOOK VERIFIED!");
    return res.status(200).send(req.query["hub.challenge"]); 
  }
  return res.sendStatus(403); 
});

async function sendWhatsAppText(to, body) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID; 
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) { 
    console.log(`[DRY RUN - Missing token/id] to ${to}: ${body.slice(0,200)}`); 
    return { dryRun: true }; 
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  try {
    const r = await fetch(url, { 
      method:"POST", 
      headers:{ "Authorization":`Bearer ${token}`, "Content-Type":"application/json" }, 
      body: JSON.stringify({ messaging_product:"whatsapp", to, type:"text", text:{ body } }) 
    });
    const result = await r.json(); 
    if (!r.ok) {
      console.error("WA error:", JSON.stringify(result));
    } else {
      console.log(`Replied to ${to} - id: ${result.messages?.[0]?.id}`);
    }
    return result;
  } catch (e) {
    console.error("WA fetch error:", e.message);
  }
}

app.post("/webhook", async (req,res) => {
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const from = msg.from; 
          if (!from) continue;
          const isAdminUser = isAdmin(from);

          // --- ADMIN FLOW ---
          if (isAdminUser) {
            if (msg.type === "text" && msg.text.body.toLowerCase().startsWith("add |")) {
              const parts = msg.text.body.split("|").map(s=>s.trim());
              if (parts.length >= 5) {
                const [, categoryRaw, name, phone, address] = parts;
                const category = normalizeCategory(categoryRaw) || categoryRaw.toLowerCase();
                const state = adminAddState.get(from);
                if (!state || !state.lat) { 
                  await sendWhatsAppText(from, `You used quick add but no location yet.\n\nPlease first SHARE LOCATION of the provider, then type:\nADD | ${category} | ${name} | ${phone} | ${address}`); 
                  continue; 
                }
                const providers = loadProviders();
                providers.push({ id: category.slice(0,4)+"_"+Date.now(), name, category, phone, address, lat: state.lat, lon: state.lon, verificationStatus: "verified", availabilityStatus: "available", lastConfirmedAt: new Date().toISOString().slice(0,10) });
                saveProviders(providers); 
                adminAddState.delete(from);
                await sendWhatsAppText(from, `✅ Saved!\n${name} (${category}) added at ${state.lat},${state.l
