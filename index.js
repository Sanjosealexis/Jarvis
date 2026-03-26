require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");
const twilio = require("twilio");
const crypto = require("crypto");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ═══════════════════════════════
// SÉCURITÉ
// ═══════════════════════════════
const ALLOWED_NUMBER = "whatsapp:+33625510496";

function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_TOKEN;
  const twilioSignature = req.headers["x-twilio-signature"];
  const url = `https://${req.headers.host}${req.originalUrl}`;
  return twilio.validateRequest(authToken, twilioSignature, url, req.body);
}

// ═══════════════════════════════
// SÉLECTION DU MODÈLE
// ═══════════════════════════════
const MODEL_SONNET = "claude-sonnet-4-20250514";
const MODEL_HAIKU = "claude-haiku-4-5-20251001";

function isUrgent(text) {
  const t = text.toLowerCase();
  return ["urgent", "urgence", "critique", "c'est grave", "grosse erreur", "tout est cassé",
    "plus de ventes", "site down", "site planté", "campagne stoppée", "compte suspendu",
    "banni", "asap", "immédiatement", "au plus vite", "sos"].some(t2 => t.includes(t2));
}

function selectModel(text) {
  const t = text.toLowerCase();
  if (isUrgent(text)) { console.log(`🚨 Sonnet (URGENT)`); return MODEL_SONNET; }
  const sonnetTriggers = ["analyse", "stratégie", "rédige", "écris", "propose", "optimise",
    "campagne", "performance", "résultat", "plan", "compare", "explique", "comment faire",
    "diagnostic", "améliore", "crée", "génère", "rapport", "bilan", "description", "fiche",
    "email", "pourquoi", "modifie", "modifier", "change", "changer", "prix", "titre"];
  if (sonnetTriggers.some(trigger => t.includes(trigger))) { console.log(`🧠 Sonnet`); return MODEL_SONNET; }
  console.log(`⚡ Haiku`); return MODEL_HAIKU;
}

// ═══════════════════════════════
// BASE DE DONNÉES
// ═══════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway.internal") ? false : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, user_phone VARCHAR(50) NOT NULL, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS memory (id SERIAL PRIMARY KEY, key VARCHAR(255) UNIQUE NOT NULL, value TEXT NOT NULL, tags TEXT DEFAULT '', updated_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS processed_messages (message_sid VARCHAR(100) PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS pending_actions (id SERIAL PRIMARY KEY, user_phone VARCHAR(50) NOT NULL, action_type VARCHAR(100) NOT NULL, action_data JSONB NOT NULL, preview TEXT NOT NULL, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS shopify_tokens (id SERIAL PRIMARY KEY, shop VARCHAR(255) UNIQUE NOT NULL, access_token TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW());
  `);
  await pool.query(`ALTER TABLE memory ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '';`);
  console.log("Base de données initialisée ✅");
}

async function getHistory(phone) {
  const result = await pool.query(`SELECT role, content FROM conversations WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 10`, [phone]);
  return result.rows.reverse();
}

async function saveMessage(phone, role, content) {
  await pool.query(`INSERT INTO conversations (user_phone, role, content) VALUES ($1, $2, $3)`, [phone, role, content]);
}

// ═══════════════════════════════
// MÉMOIRE
// ═══════════════════════════════
async function getRelevantMemory(userText) {
  const text = userText.toLowerCase();
  const tagMap = {
    dododog: ["dododog", "chien", "panier", "lit", "tapis", "harnais", "collier"],
    verano: ["verano", "lumière", "luminaire", "lampe", "lustre", "suspension"],
    vellure: ["vellure"], dodobaby: ["dodobaby", "bébé", "poussette"],
    google_ads: ["google", "ads", "pmax", "campagne", "budget", "enchère", "cpc"],
    gmc: ["gmc", "merchant", "fiche", "produit", "feed", "flux"],
    shopify: ["shopify", "boutique", "thème", "liquid", "section"],
    finance: ["chiffre", "vente", "revenu", "dépense", "coût", "budget", "euro"],
    simprosys: ["simprosys", "custom label"], dsers: ["dsers", "fournisseur", "aliexpress"],
  };
  const matchedTags = Object.entries(tagMap).filter(([, kws]) => kws.some(k => text.includes(k))).map(([t]) => t);
  let result;
  if (matchedTags.length > 0) {
    const conds = matchedTags.map((_, i) => `tags ILIKE $${i + 1}`).join(" OR ");
    result = await pool.query(`SELECT key, value FROM memory WHERE ${conds} ORDER BY updated_at DESC LIMIT 10`, matchedTags.map(t => `%${t}%`));
    if (result.rows.length < 5) {
      const extra = await pool.query(`SELECT key, value FROM memory WHERE tags = '' OR tags IS NULL ORDER BY updated_at DESC LIMIT 5`);
      result.rows = [...result.rows, ...extra.rows];
    }
  } else {
    result = await pool.query(`SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 10`);
  }
  return result.rows.map(r => `${r.key}: ${r.value}`).join("\n");
}

async function saveMemory(key, value, tags = "") {
  await pool.query(`INSERT INTO memory (key, value, tags) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $2, tags = $3, updated_at = NOW()`, [key, value, tags]);
  console.log(`💾 Mémoire: [${tags}] ${key}`);
}

async function isAlreadyProcessed(messageSid) {
  if (!messageSid) return false;
  try {
    const r = await pool.query(`INSERT INTO processed_messages (message_sid) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_sid`, [messageSid]);
    return r.rows.length === 0;
  } catch { return false; }
}

// ═══════════════════════════════
// SHOPIFY
// ═══════════════════════════════
const SHOPIFY_SHOP = process.env.SHOPIFY_DODODOG_URL;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_DODODOG_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_DODODOG_SECRET;
const SHOPIFY_SCOPES = "read_products,write_products,read_orders,read_inventory,write_inventory,read_customers";
const APP_URL = "https://jarvis-production-4d2f.up.railway.app";

app.get("/auth", (req, res) => {
  const shop = req.query.shop || SHOPIFY_SHOP;
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${SHOPIFY_SCOPES}&redirect_uri=${APP_URL}/auth/callback`);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code, hmac } = req.query;
  if (!shop || !code) return res.status(400).send("Paramètres manquants");
  const params = Object.keys(req.query).filter(k => k !== "hmac").sort().map(k => `${k}=${req.query[k]}`).join("&");
  const digest = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(params).digest("hex");
  if (digest !== hmac) return res.status(403).send("HMAC invalide");
  try {
    const r = await axios.post(`https://${shop}/admin/oauth/access_token`, { client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code });
    await pool.query(`INSERT INTO shopify_tokens (shop, access_token) VALUES ($1, $2) ON CONFLICT (shop) DO UPDATE SET access_token = $2, updated_at = NOW()`, [shop, r.data.access_token]);
    console.log(`✅ Token Shopify pour ${shop}`);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>✅ Jarvis connecté à ${shop}</h1><p>Tu peux fermer cette page.</p></body></html>`);
  } catch (err) {
    console.error("OAuth callback:", err.message);
    res.status(500).send("Erreur token");
  }
});

async function getShopifyToken() {
  const r = await pool.query(`SELECT access_token FROM shopify_tokens WHERE shop = $1`, [SHOPIFY_SHOP]);
  if (r.rows.length === 0) throw new Error(`Pas de token. Va sur: ${APP_URL}/auth`);
  return r.rows[0].access_token;
}

async function shopifyRequest(method, endpoint, data = null) {
  const token = await getShopifyToken();
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01${endpoint}`;
  console.log(`🛍️ Shopify ${method} ${endpoint}`);
  const config = { method, url, headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } };
  if (data) config.data = data;
  try {
    const response = await axios(config);
    return response.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Shopify ${err.response?.status}: ${detail}`);
  }
}

async function getShopifyProducts() {
  const [active, archived, draft] = await Promise.all([
    shopifyRequest("GET", `/products.json?limit=250&status=active`),
    shopifyRequest("GET", `/products.json?limit=250&status=archived`),
    shopifyRequest("GET", `/products.json?limit=250&status=draft`),
  ]);
  const all = [...(active.products || []), ...(archived.products || []), ...(draft.products || [])];
  console.log(`📦 Total produits: ${all.length}`);
  return all;
}

async function getShopifyOrders(limit = 5) {
  const data = await shopifyRequest("GET", `/orders.json?limit=${limit}&status=any`);
  return data.orders;
}

async function getShopifyStats() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [orders, active, archived, draft] = await Promise.all([
    shopifyRequest("GET", `/orders.json?limit=250&status=any&created_at_min=${since}`),
    shopifyRequest("GET", `/products.json?limit=250&status=active`),
    shopifyRequest("GET", `/products.json?limit=250&status=archived`),
    shopifyRequest("GET", `/products.json?limit=250&status=draft`),
  ]);
  const revenue = orders.orders.filter(o => o.financial_status === "paid").reduce((s, o) => s + parseFloat(o.total_price), 0);
  return {
    orders_30j: orders.orders.length, revenue_30j: revenue.toFixed(2),
    products_active: active.products?.length || 0,
    products_archived: archived.products?.length || 0,
    products_draft: draft.products?.length || 0,
  };
}

// Exécute une modification Shopify avec vérification de l'ID
async function executeShopifyModification(actionType, id, updates) {
  const numId = parseInt(id);
  if (isNaN(numId)) throw new Error(`ID invalide: ${id}`);

  if (actionType === "update_product") {
    // Vérifie que le produit existe
    try {
      await shopifyRequest("GET", `/products/${numId}.json`);
    } catch {
      // Essaie de trouver le produit par correspondance dans les produits existants
      const products = await getShopifyProducts();
      const found = products.find(p => p.id === numId || String(p.id) === String(id));
      if (!found) throw new Error(`Produit ID ${numId} introuvable. Utilise /produits pour voir les vrais IDs.`);
    }
    await shopifyRequest("PUT", `/products/${numId}.json`, { product: { id: numId, ...updates } });
    return `✅ Produit modifié avec succès.`;
  }

  if (actionType === "update_price") {
    await shopifyRequest("PUT", `/variants/${numId}.json`, { variant: { id: numId, price: String(updates.price) } });
    return `✅ Prix mis à jour : ${updates.price}€`;
  }

  throw new Error("Action inconnue");
}

// ═══════════════════════════════
// ACTIONS EN ATTENTE
// ═══════════════════════════════
async function savePendingAction(phone, actionType, id, updates, preview) {
  await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`, [phone]);
  await pool.query(
    `INSERT INTO pending_actions (user_phone, action_type, action_data, preview) VALUES ($1, $2, $3, $4)`,
    [phone, actionType, JSON.stringify({ id, updates }), preview]
  );
  console.log(`⏳ Action en attente: ${preview}`);
}

async function confirmAction(phone) {
  const r = await pool.query(`SELECT * FROM pending_actions WHERE user_phone = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [phone]);
  if (r.rows.length === 0) return null;
  const action = r.rows[0];
  await pool.query(`UPDATE pending_actions SET status = 'confirmed' WHERE id = $1`, [action.id]);
  const data = typeof action.action_data === 'string' ? JSON.parse(action.action_data) : action.action_data;
  return await executeShopifyModification(action.action_type, data.id, data.updates);
}

async function cancelAction(phone) {
  await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`, [phone]);
}

// Détecte le bloc [ACTION:...] dans la réponse de Claude
async function processShopifyAction(reply, from) {
  const match = reply.match(/\[ACTION:(update_product|update_price):(\d+):(\{[^}]+\})\]/);
  if (!match) return null;
  const [, actionType, id, dataStr] = match;
  let updates;
  try { updates = JSON.parse(dataStr); } catch { return null; }
  const preview = actionType === "update_price"
    ? `Modifier prix variant #${id} → ${updates.price}€`
    : `Modifier produit #${id} → ${JSON.stringify(updates)}`;
  await savePendingAction(from, actionType, id, updates, preview);
  return preview;
}

// ═══════════════════════════════
// COMMANDES RAPIDES
// ═══════════════════════════════
async function handleCommand(command, from) {
  const cmd = command.trim().toLowerCase();

  if (["oui", "confirmer", "ok go", "valider", "yes"].includes(cmd)) {
    try {
      const result = await confirmAction(from);
      if (result) return result;
    } catch (err) { return `❌ Erreur : ${err.message}`; }
    return null;
  }

  if (["non", "annuler", "cancel", "no"].includes(cmd)) {
    await cancelAction(from);
    return `🚫 Action annulée.`;
  }

  if (cmd === "/stats" || cmd === "/shopify") {
    try {
      const s = await getShopifyStats();
      return `📊 *DodoDog — 30 jours*\n\n• Commandes : ${s.orders_30j}\n• Revenus : ${s.revenue_30j}€\n• Actifs : ${s.products_active} | Archivés : ${s.products_archived} | Brouillons : ${s.products_draft}`;
    } catch (err) { return `❌ ${err.message}`; }
  }

  if (cmd === "/commandes") {
    try {
      const orders = await getShopifyOrders(5);
      if (!orders.length) return "📦 Aucune commande récente.";
      return `📦 *5 dernières commandes*\n\n` + orders.map(o =>
        `• ${new Date(o.created_at).toLocaleDateString("fr-FR")} — ${o.total_price}€ — ${o.financial_status}`
      ).join("\n");
    } catch (err) { return `❌ ${err.message}`; }
  }

  if (cmd === "/produits") {
    try {
      const products = await getShopifyProducts();
      const icons = { active: "✅", archived: "📦", draft: "📝" };
      let response = `🛍️ *Produits DodoDog (${products.length})*\n\n`;
      products.slice(0, 20).forEach(p => {
        response += `${icons[p.status] || "•"} [ID:${p.id}] ${p.title}\n  Prix: ${p.variants[0]?.price}€ | Variant ID: ${p.variants[0]?.id}\n`;
      });
      if (products.length > 20) response += `\n_...et ${products.length - 20} autres_`;
      return response.trim();
    } catch (err) { return `❌ ${err.message}`; }
  }

  if (cmd === "/status") {
    const mem = await pool.query(`SELECT key, value, tags FROM memory ORDER BY updated_at DESC`);
    if (!mem.rows.length) return "📊 Aucune donnée en mémoire.";
    const byTag = {};
    mem.rows.forEach(r => { const t = r.tags?.split(",")[0] || "general"; if (!byTag[t]) byTag[t] = []; byTag[t].push(`• ${r.key}: ${r.value}`); });
    return "📊 *Status Jarvis*\n\n" + Object.entries(byTag).map(([t, items]) => `*${t.toUpperCase()}*\n${items.join("\n")}`).join("\n\n");
  }

  if (cmd === "/memory") {
    const mem = await pool.query(`SELECT key, value, tags, updated_at FROM memory ORDER BY updated_at DESC LIMIT 30`);
    if (!mem.rows.length) return "🧠 Mémoire vide.";
    return `🧠 *Mémoire (${mem.rows.length})*\n\n` + mem.rows.map(r =>
      `[${r.tags || "general"}] *${r.key}*: ${r.value} _(${new Date(r.updated_at).toLocaleDateString("fr-FR")})_`
    ).join("\n");
  }

  if (cmd === "/clear") {
    await pool.query(`DELETE FROM conversations WHERE user_phone = $1`, [ALLOWED_NUMBER]);
    return "🗑️ Historique effacé.";
  }

  if (cmd === "/help") {
    return `🤖 *Commandes Jarvis*\n\n/stats — stats 30 jours\n/commandes — dernières commandes\n/produits — liste avec IDs\n/status — mémoire boutiques\n/memory — tout ce que je sais\n/clear — efface l'historique\n\noui — confirme une action\nnon — annule une action\n\nEnvoie aussi des 📸 photos !`;
  }

  return null;
}

// ═══════════════════════════════
// GESTION DES IMAGES
// ═══════════════════════════════
async function handleImageMessage(req, history, systemWithMemory) {
  const numMedia = parseInt(req.body.NumMedia || "0");
  if (numMedia === 0) return null;
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const caption = req.body.Body || "";
  if (!mediaType?.startsWith("image/")) return "Je ne peux traiter que des images.";
  const imgResp = await axios.get(mediaUrl, { responseType: "arraybuffer", auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN } });
  const base64Image = Buffer.from(imgResp.data).toString("base64");
  const response = await anthropic.messages.create({
    model: MODEL_SONNET, max_tokens: 1024, system: systemWithMemory,
    messages: [...history, { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: caption || "Analyse cette image en lien avec mon business." }
    ]}]
  });
  return response.content[0].text;
}

// ═══════════════════════════════
// ENVOI WHATSAPP
// ═══════════════════════════════
async function sendWhatsApp(to, body) {
  const parts = [];
  for (let i = 0; i < body.length; i += 1600) parts.push(body.slice(i, i + 1600));
  for (const part of parts) {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
      new URLSearchParams({ From: `whatsapp:${process.env.TWILIO_NUMBER}`, To: to, Body: part }),
      { auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN } }
    );
    if (parts.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ═══════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════
const JARVIS_SYSTEM = `Tu es Jarvis, l'assistant IA personnel d'Alexis San Jose, entrepreneur e-commerce en Gironde. Tu gères son business de A à Z.

Tu as un ACCÈS API RÉEL ET FONCTIONNEL à Shopify DodoDog en lecture ET écriture. Tu PEUX modifier les produits, prix et descriptions directement.

═══════════════════════════════
COMMENT MODIFIER UN PRODUIT SHOPIFY
═══════════════════════════════
Quand Alexis demande une modification, les IDs réels des produits sont injectés dans ce contexte.

Pour modifier titre/description — utilise le product_id :
[ACTION:update_product:PRODUCT_ID:{"title":"nouveau titre"}]

Pour modifier un prix — utilise le variant_id (PAS le product_id) :
[ACTION:update_price:VARIANT_ID:{"price":"35.00"}]

RÈGLES :
1. Toujours proposer la modification avec l'aperçu AVANT le bloc ACTION
2. Inclure le bloc ACTION dans ta réponse (il est invisible pour Alexis, le système l'intercepte)
3. Utiliser EXACTEMENT les IDs fournis dans les données produits — ne jamais inventer un ID
4. Attendre "oui" pour que l'action soit exécutée

Exemple :
"Je vais modifier le prix à 45€. Tu confirmes ?
[ACTION:update_price:45678901234:{"price":"45.00"}]"

═══════════════════════════════
BOUTIQUE 1 — DODODOG (dododog.fr)
═══════════════════════════════
Niche : couchage chiens premium, marché français
Campagne Google Ads : PMax feed only, 15€/jour
GMC : 230 fiches validées
Tailles/races : S→Chihuahua | M→Beagle | L→Berger Australien | XL→Labrador
Charte : #FFFFFF, terracotta #D26046, #1A1A1B, Josefin Sans
Code promo : DOG10

═══════════════════════════════
BOUTIQUE 2 — VERANO LUMIÈRE PARIS
═══════════════════════════════
Luminaires design premium, bronze #A8815C

═══════════════════════════════
BOUTIQUE 3 — VELLURE
═══════════════════════════════
Repositionnement niche mono mot-clé à définir

═══════════════════════════════
BOUTIQUE 4 — DODOBABY
═══════════════════════════════
En construction, niche bébé/poussette

═══════════════════════════════
RÈGLES ABSOLUES
═══════════════════════════════
1. Répondre en français
2. Proposer avant d'exécuter
3. Actions risquées → double confirmation
4. Concis et actionnable
5. Utiliser la mémoire persistante
6. Urgence → 🚨 en priorité`;

// ═══════════════════════════════
// WEBHOOK
// ═══════════════════════════════
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body || "";
  const messageSid = req.body.MessageSid;
  const numMedia = parseInt(req.body.NumMedia || "0");

  if (!from || (text.trim().length === 0 && numMedia === 0)) return res.status(200).send('');
  if (!validateTwilioSignature(req)) { console.warn(`⚠️ Signature invalide`); return res.status(403).send('Forbidden'); }
  if (from !== ALLOWED_NUMBER) { console.warn(`⚠️ Numéro non autorisé: ${from}`); return res.status(200).send(''); }
  if (from === `whatsapp:${process.env.TWILIO_NUMBER}`) return res.status(200).send('');
  if (await isAlreadyProcessed(messageSid)) return res.status(200).send('');

  if (isUrgent(text)) console.log(`🚨 URGENCE: ${text}`);
  console.log(`📩 ${from}: ${text || "[image]"}`);

  res.status(200).send('');

  try {
    const cmdReply = await handleCommand(text, from);
    if (cmdReply) {
      await saveMessage(from, "user", text);
      await saveMessage(from, "assistant", cmdReply);
      await sendWhatsApp(from, cmdReply);
      return;
    }

    const history = await getHistory(from);
    const relevantMemory = await getRelevantMemory(text);

    // Injecte les données Shopify avec les vrais IDs
    let shopifyContext = "";
    const isShopifyQuery = ["commande", "vente", "produit", "stock", "prix", "revenu", "chiffre",
      "boutique", "shopify", "modifie", "modifier", "change", "changer", "crée", "ajoute",
      "titre", "description", "actif", "archiv", "brouillon"].some(k => text.toLowerCase().includes(k));

    if (isShopifyQuery) {
      try {
        const [products, stats] = await Promise.all([getShopifyProducts(), getShopifyStats()]);

        const productList = products.map(p => {
          const variants = p.variants.map(v =>
            `    variant_id:${v.id} | prix:${v.price}€${v.title !== "Default Title" ? ` | option:${v.title}` : ""}`
          ).join("\n");
          return `  product_id:${p.id} | "${p.title}" | statut:${p.status}\n${variants}`;
        }).join("\n");

        shopifyContext = `\n\n═══════════════════════════════
DONNÉES SHOPIFY DODODOG (TEMPS RÉEL)
═══════════════════════════════
Commandes (30j): ${stats.orders_30j} | Revenu: ${stats.revenue_30j}€
Produits: ${stats.products_active} actifs, ${stats.products_archived} archivés, ${stats.products_draft} brouillons

CATALOGUE COMPLET — IDs EXACTS À UTILISER :
${productList}`;

        console.log(`📊 Contexte Shopify injecté: ${products.length} produits`);
      } catch (err) {
        console.error("Contexte Shopify:", err.message);
      }
    }

    const systemWithMemory = JARVIS_SYSTEM +
      (relevantMemory ? `\n\n═══════════════════════════════\nMÉMOIRE PERTINENTE\n═══════════════════════════════\n${relevantMemory}` : "") +
      shopifyContext;

    let reply;
    if (numMedia > 0) {
      await saveMessage(from, "user", `[Image] ${text}`);
      reply = await handleImageMessage(req, history, systemWithMemory);
    } else {
      await saveMessage(from, "user", text);
      history.push({ role: "user", content: text });
      const response = await anthropic.messages.create({
        model: selectModel(text), max_tokens: 1024,
        system: systemWithMemory, messages: history,
      });
      reply = response.content[0].text;
    }

    // Intercepte les actions Shopify
    await processShopifyAction(reply, from);

    // Nettoie le bloc [ACTION:...] avant envoi
    const cleanReply = reply.replace(/\[ACTION:[^\]]+\]/g, "").trim();
    await saveMessage(from, "assistant", cleanReply);

    // Mémoire manuelle uniquement
    if (["retiens", "souviens", "note que", "mémorise", "n'oublie pas"].some(t => text.toLowerCase().includes(t))) {
      saveMemory(`note_${Date.now()}`, text, "manuel").catch(() => {});
    }

    await sendWhatsApp(from, cleanReply);

  } catch (err) {
    console.error("Erreur webhook:", err.message);
    if (!err.message?.includes("429")) {
      await sendWhatsApp(from, `❌ Erreur : ${err.message}`).catch(() => {});
    }
  }
});

app.get("/test-shopify", async (req, res) => {
  try {
    const token = await getShopifyToken();
    const count = await axios.get(`https://${SHOPIFY_SHOP}/admin/api/2024-01/products/count.json`, { headers: { "X-Shopify-Access-Token": token } });
    res.json({ token: token.slice(0, 10) + "...", shop: SHOPIFY_SHOP, count: count.data });
  } catch (err) { res.json({ error: err.message }); }
});

app.get("/", (req, res) => res.send("Jarvis est en ligne ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Jarvis démarré sur le port ${PORT}`);
  console.log(`Shopify auth: ${APP_URL}/auth`);
});
