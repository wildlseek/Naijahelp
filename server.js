require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const PROVIDERS_FILE = path.join(__dirname, "providers.json");
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v22.0";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "naijahelp2026";
const ADMIN_NUMBERS = (process.env.ADMIN_WHATSAPP_NUMBERS || "").split(",").map(s=>s.trim()).filter(Boolean);

const userLastCategory = new Map();
const adminAddState = new Map();

function loadProviders() { try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8")); } catch (e) { console.log("Could not read providers.json:", e.message); return []; } }
function saveProviders(data) { fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2)); }
function distanceKm(lat1, lon1, lat2, lon2) { const toRad = d => d * Math.PI / 180; const R = 6371; const dLat = toRad(lat2-lat1); const dLon = toRad(lon2-lon1); const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2; return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
function mapsLink(lat, lon) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lon}`)}`; }
function searchHelper({ lat, lon, category, radius = 5, limit = 3 }) {
  const all = loadProviders().filter(p => p.category === category).filter(p => p.verificationStatus === "verified").filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map(p => ({ ...p, distanceKm: distanceKm(lat, lon, p.lat, p.lon), mapsUrl: mapsLink(p.lat, p.lon) })).sort((a,b) => a.distanceKm-b.distanceKm);
  let results = all.filter(p => p.distanceKm <= radius).slice(0, limit); let usedRadius = radius;
  if (results.length === 0 && radius < 10) { results = all.filter(p => p.distanceKm <= 10).slice(0, limit); usedRadius = 10; }
  if (results.length === 0 && radius < 20) { results = all.filter(p => p.distanceKm <= 20).slice(0, limit); usedRadius = 20; }
  return { results, usedRadius, totalInCategory: all.length };
}
function formatWhatsAppResults(category, searchResult) {
  const { results, usedRadius } = searchResult; if (results.length === 0) return `No verified ${category} found within 20km.`;
  let reply = `Nearest ${category.toUpperCase()} (${results.length} found within ${usedRadius}km):\n`;
  results.forEach((p,i) => { reply += `\n${i+1}. ${p.name} - ${p.distanceKm.toFixed(1)}km\n${p.address}\n📞 ${p.phone}\n🗺️ ${p.mapsUrl}\n`; });
  reply += `\nReply MENU for other services.`; return reply;
}
function normalizeCategory(text) { text = text.toLowerCase(); if (/hospital|clinic|doctor/.test(text)) return "hospital"; if (/pharm|drug|chemist/.test(text)) return "pharmacy"; if (/mechanic|rewire|car repair|auto/.test(text)) return "mechanic"; if (/vulcanizer|vulcaniser|tyre|tire|pump/.test(text)) return "vulcanizer"; if (/tow/.test(text)) return "towing"; if (/ambulance|emergency|paramedic/.test(text)) return "ambulance"; return null; }
function isAdmin(number) { const clean = number.replace(/^\+/,""); return ADMIN_NUMBERS.some(a => clean.endsWith(a.replace(/^\+/,"")) || a.replace(/^\+/,"").endsWith(clean)); }

app.get("/health", (req,res) => res.json({ ok:true, providers: loadProviders().length }));
app.get("/search", (req,res) => { const lat = Number(req.query.lat); const lon = Number(req.query.lon); const category = String(req.query.category || "").toLowerCase(); const radius = Math.min(Number(req.query.radius || 5), 20); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "Valid lat/lon required." }); const { results, usedRadius, totalInCategory } = searchHelper({ lat, lon, category, radius }); res.json({ category, usedRadius, totalInCategory, count: results.length, results }); });
app.get("/webhook", (req,res) => { if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) return res.status(200).send(req.query["hub.challenge"]); return res.sendStatus(403); });

async function sendWhatsAppText(to, body) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID; const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) { console.log(`[DRY RUN to ${to}]: ${body.slice(0,500)}`); return; }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  const r = await fetch(url, { method:"POST", headers:{ "Authorization":`Bearer ${token}`, "Content-Type":"application/json" }, body: JSON.stringify({ messaging_product:"whatsapp", to, type:"text", text:{ body } }) });
  const result = await r.json(); if (!r.ok) console.error("WA error:", result);
}

app.post("/webhook", async (req,res) => {
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const from = msg.from; if (!from) continue;
          const isAdminUser = isAdmin(from);
          if (isAdminUser) {
            if (msg.type === "text" && msg.text.body.toLowerCase().startsWith("add |")) {
              const parts = msg.text.body.split("|").map(s=>s.trim());
              if (parts.length >= 5) {
                const [, categoryRaw, name, phone, address] = parts;
                const category = normalizeCategory(categoryRaw) || categoryRaw.toLowerCase();
                const state = adminAddState.get(from);
                if (!state || !state.lat) { await sendWhatsAppText(from, `You used quick add but no location yet.\n\nPlease first SHARE LOCATION of the provider, then type:\nADD | ${category} | ${name} | ${phone} | ${address}`); continue; }
                const providers = loadProviders();
                providers.push({ id: category.slice(0,4)+"_"+Date.now(), name, category, phone, address, lat: state.lat, lon: state.lon, verificationStatus: "verified", availabilityStatus: "available", lastConfirmedAt: new Date().toISOString().slice(0,10) });
                saveProviders(providers); adminAddState.delete(from);
                await sendWhatsAppText(from, `✅ Saved!\n${name} (${category}) added at ${state.lat},${state.lon}\nTotal providers now: ${providers.length}`);
                continue;
              }
            }
            if (msg.type === "location") {
              adminAddState.set(from, { lat: msg.location.latitude, lon: msg.location.longitude });
              await sendWhatsAppText(from, `📍 Location received: ${msg.location.latitude}, ${msg.location.longitude}\n\nNow send:\nADD | category | name | phone | address\n\nExample:\nADD | mechanic | Bayo Autos | +2348034567890 | Maruwa Bus Stop, Lekki`);
              continue;
            }
            if (msg.type === "text" && msg.text.body.toLowerCase().trim() === "add provider") {
              await sendWhatsAppText(from, `To add provider:\n1. Go to provider shop\n2. Tap + > Location > Share Location\n3. Then send: ADD | category | name | phone | address\n\nCategories: hospital, pharmacy, mechanic, vulcanizer, towing, ambulance`);
              continue;
            }
            if (msg.type === "text" && msg.text.body.toLowerCase().trim() === "list providers") {
              const providers = loadProviders(); const summary = providers.slice(-10).map(p=>`${p.category}: ${p.name} - ${p.phone}`).join("\n");
              await sendWhatsAppText(from, `Total: ${providers.length}\nLast 10:\n${summary}`);
              continue;
            }
          }
          if (msg.type === "text") {
            const text = (msg.text?.body || "").trim().toLowerCase();
            if (["hi","hello","menu","start"].includes(text)) {
              const menu = `NaijaHelp 📍\n\nReply with service:\n1. hospital\n2. pharmacy\n3. mechanic\n4. vulcanizer\n5. towing\n6. ambulance\n\nThen share your location ( + > Location )`;
              await sendWhatsAppText(from, isAdminUser ? menu + `\n\n--- ADMIN ---\nType "add provider" to add new shop\nType "list providers" to see count` : menu);
              continue;
            }
            const cat = normalizeCategory(text);
            if (cat) { userLastCategory.set(from, cat); await sendWhatsAppText(from, `Got it - ${cat}. Now share your location 📍`); }
          } else if (msg.type === "location") {
            if (isAdminUser && adminAddState.has(from)) continue;
            const lat = msg.location?.latitude; const lng = msg.location?.longitude;
            const category = userLastCategory.get(from) || "hospital";
            const searchResult = searchHelper({ lat, lon: lng, category, radius: 5, limit: 3 });
            await sendWhatsAppText(from, formatWhatsAppResults(category, searchResult));
          }
        }
      }
    }
  } catch (e) { console.error("Webhook error:", e.message); }
});

app.get("/admin", (req,res) => {
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NaijaHelp Admin</title><style>body{font-family:sans-serif;padding:20px;max-width:600px;margin:auto}input,select{width:100%;padding:10px;margin:6px 0;border:1px solid #ccc;border-radius:8px}button{width:100%;padding:12px;background:#25D366;color:white;border:none;border-radius:8px;font-weight:bold;margin-top:10px}.card{border:1px solid #eee;padding:12px;border-radius:8px;margin:8px 0}</style></head><body><h2>NaijaHelp - Add Provider (Lekki/Ikoyi/VI)</h2><form id="form"><input name="name" placeholder="Business Name e.g. Bayo Autos" required><select name="category" required><option value="">Select Service</option><option>hospital</option><option>pharmacy</option><option>mechanic</option><option>vulcanizer</option><option>towing</option><option>ambulance</option></select><input name="phone" placeholder="Phone e.g. +2348034567890" required><input name="address" placeholder="Address e.g. Admiralty Way, Lekki" required><input name="lat" type="number" step="any" placeholder="Latitude - e.g. 6.4388" required><input name="lon" type="number" step="any" placeholder="Longitude - e.g. 3.4603" required><select name="availabilityStatus"><option>available</option><option>open</option><option>24hrs</option><option>busy</option></select><input name="adminToken" placeholder="Admin Token: naijahelp2026" required><button type="submit">Save Provider</button></form><div id="msg" style="margin:10px 0;font-weight:bold"></div><h3>Current Providers (<span id="count">0</span>)</h3><div id="list"></div><script>async function load(){const r=await fetch('/admin/providers');const data=await r.json();document.getElementById('count').innerText=data.length;document.getElementById('list').innerHTML=data.map(p=>\`<div class=card><b>\${p.name}</b> (\${p.category})<br>\${p.address}<br>\${p.phone}<br>\${p.lat},\${p.lon}<br><button onclick="del('\${p.id}')" style="background:red;width:auto;padding:4px 10px;margin-top:5px">Delete</button></div>\`).join('');}async function del(id){const token=prompt('Admin Token');await fetch('/admin/providers/'+id+'?token='+token,{method:'DELETE'});load();}document.getElementById('form').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);const obj=Object.fromEntries(fd.entries());obj.lat=Number(obj.lat);obj.lon=Number(obj.lon);const r=await fetch('/admin/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)});const res=await r.json();document.getElementById('msg').innerText=res.message||res.error;if(r.ok){e.target.reset();load();}};load();</script></body></html>`);
});
app.get("/admin/providers", (req,res) => res.json(loadProviders()));
app.post("/admin/providers", (req,res) => { const { name, category, phone, address, lat, lon, availabilityStatus, adminToken } = req.body; if (adminToken !== ADMIN_TOKEN) return res.status(401).json({ error: "Wrong admin token" }); if (!name || !category || !phone || !address || !Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "All fields required" }); const providers = loadProviders(); const np={ id: category.slice(0,4)+"_"+Date.now(), name, category: category.toLowerCase(), phone, address, lat, lon, verificationStatus:"verified", availabilityStatus:availabilityStatus||"available", lastConfirmedAt: new Date().toISOString().slice(0,10) }; providers.push(np); saveProviders(providers); res.json({ message: "Saved! "+name+" added", provider: np }); });
app.delete("/admin/providers/:id", (req,res) => { if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "Wrong token" }); let providers=loadProviders(); providers=providers.filter(p=>p.id!==req.params.id); saveProviders(providers); res.json({ message:"Deleted" }); });

app.listen(PORT, () => console.log(`NaijaHelp listening on ${PORT} - Admin at /admin`));