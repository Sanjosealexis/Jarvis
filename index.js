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
  const urgentTriggers = [
    "urgent", "urgence", "critique", "problème critique",
    "c'est grave", "grosse erreur", "tout est cassé",
    "plus de ventes", "site down", "site planté",
    "campagne stoppée", "compte suspendu", "banni",
    "asap", "immédiatement", "au plus vite", "sos"
  ];
  return urgentTriggers.some(t2 => t.includes(t2));
}

function selectModel(text) {
  const t = text.toLowerCase();
  if (isUrgent(text)) {
    console.log(`🚨 Modèle: Sonnet (URGENT)`);
    return MODEL_SONNET;
  }
  const sonnetTriggers = [
    "analyse", "analyser", "analysons", "stratégie", "stratégique",
    "rédige", "rédiger", "écris", "propose", "optimise", "optimiser",
    "campagne", "performance", "résultat", "plan", "planning",
    "compare", "comparaison", "explique", "comment faire", "aide moi à",
    "diagnostic", "problème", "améliore", "améliorer",
    "crée", "créer", "génère", "rapport", "bilan",
    "description produit", "fiche produit", "email", "mail",
    "pourquoi", "comment se fait", "modifie", "modifier", "change", "changer",
    "prix", "titre", "description"
  ];
  if (sonnetTriggers.some(trigger => t.includes(trigger))) {
    console.log(`🧠 Modèle: Sonnet (tâche complexe)`);
    return MODEL_SONNET;
  }
  console.log(`⚡ Modèle: Haiku (message simple)`);
  return MODEL_HAIKU;
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
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memory (
      id SERIAL PRIMARY KEY,
      key VARCHAR(255) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      tags TEXT DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_sid VARCHAR(100) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      action_type VARCHAR(100) NOT NULL,
      action_data JSONB NOT NULL,
      preview TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shopify_tokens (
      id SERIAL PRIMARY KEY,
      shop VARCHAR(255) UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE memory ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '';`);
  console.log("Base de données initialisée ✅");
}

async function getHistory(phone) {
  const result = await pool.query(
    `SELECT role, content FROM conversations WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 10`,
    [phone]
  );
  return result.rows.reverse();
}

async function saveMessage(phone, role, content) {
  await pool.query(
    `INSERT INTO conversations (user_phone, role, content) VALUES ($1, $2, $3)`,
    [phone, role, content]
  );
}

// ═══════════════════════════════
// MÉMOIRE
// ═══════════════════════════════
async function getRelevantMemory(userText) {
  const text = userText.toLowerCase();
  const tagMap = {
    dododog: ["dododog", "chien", "panier", "lit", "tapis", "harnais", "collier"],
    verano: ["verano", "lumière", "luminaire", "lampe", "lustre", "suspension"],
    vellure: ["vellure"],
    dodobaby: ["dodobaby", "bébé", "poussette"],
    google_ads: ["google", "ads", "pmax", "campagne", "budget", "enchère", "cpc"],
    gmc: ["gmc", "merchant", "fiche", "produit", "feed", "flux"],
    shopify: ["shopify", "boutique", "thème", "liquid", "section"],
    finance: ["chiffre", "vente", "revenu", "dépense", "coût", "budget", "euro"],
    simprosys: ["simprosys", "custom label", "flux"],
    dsers: ["dsers", "fournisseur", "aliexpress", "commande"],
  };
  const matchedTags = [];
  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some(k => text.includes(k))) matchedTags.push(tag);
  }
  let result;
  if (matchedTags.length > 0) {
    const tagConditions = matchedTags.map((_, i) => `tags ILIKE $${i + 1}`).join(" OR ");
    result = await pool.query(
      `SELECT key, value FROM memory WHERE ${tagConditions} ORDER BY updated_at DESC LIMIT 10`,
      matchedTags.map(t => `%${t}%`)
    );
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
  await pool.query(
    `INSERT INTO memory (key, value, tags) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $2, tags = $3, updated_at = NOW()`,
    [key, value, tags]
  );
  console.log(`💾 Mémoire: [${tags}] ${key} = ${value}`);
}

async function isAlreadyProcessed(messageSid) {
  if (!messageSid) return false;
  try {
    const result = await pool.query(
      `INSERT INTO processed_messages (message_sid) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_sid`,
      [messageSid]
    );
    return result.rows.length === 0;
  } catch { return false; }
}

// ═══════════════════════════════
// SHOPIFY OAUTH
// ═══════════════════════════════
const SHOPIFY_SHOP = process.env.SHOPIFY_DODODOG_URL;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_DODODOG_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_DODODOG_SECRET;
const SHOPIFY_SCOPES = "read_products,write_products,read_orders,read_inventory,write_inventory,read_customers";
const APP_URL = "https://jarvis-production-4d2f.up.railway.app";

app.get("/auth", (req, res) => {
  const shop = req.query.shop || SHOPIFY_SHOP;
  const redirectUri = `${APP_URL}/auth/callback`;
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${SHOPIFY_SCOPES}&redirect_uri=${redirectUri}`);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code, hmac } = req.query;
  if (!shop || !code) return res.status(400).send("Paramètres manquants");
  const params = Object.keys(req.query).filter(k => k !== "hmac").sort().map(k => `${k}=${req.query[k]}`).join("&");
  const digest = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(params).digest("hex");
  if (digest !== hmac) return res.status(403).send("HMAC invalide");
  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code,
    });
    const { access_token } = response.data;
    await pool.query(
      `INSERT INTO shopify_tokens (shop, access_token) VALUES ($1, $2) ON CONFLICT (shop) DO UPDATE SET access_token = $2, updated_at = NOW()`,
      [shop, access_token]
    );
    console.log(`✅ Token Shopify obtenu pour ${shop}`);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>✅ Jarvis connecté à ${shop}</h1><p>Tu peux fermer cette page.</p></body></html>`);
  } catch (err) {
    console.error("❌ OAuth callback:", err.message);
    res.status(500).send("Erreur lors de l'obtention du token");
  }
});

async function getShopifyToken() {
  const result = await pool.query(`SELECT access_token FROM shopify_tokens WHERE shop = $1`, [SHOPIFY_SHOP]);
  if (result.rows.length === 0) throw new Error(`Pas de token. Va sur: ${APP_URL}/auth`);
  return result.rows[0].access_token;
}

async function shopifyRequest(method, endpoint, data = null) {
  const token = await getShopifyToken();
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01${endpoint}`;
  console.log(`🛍️ Shopify ${method} ${endpoint}`);
  const config = {
    method, url,
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  };
  if (data) config.data = data;
  try {
    const response = await axios(config);
    return response.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Shopify ${err.response?.status}: ${detail}`);
  }
}

async function getShopifyOrders(limit = 10) {
  const data = await shopifyRequest("GET", `/orders.json?limit=${limit}&status=any`);
  return data.orders;
}

async function getShopifyProducts() {
  const [active, archived, draft] = await Promise.all([
    shopifyRequest("GET", `/products.json?limit=250&status=active`),
    shopifyRequest("GET", `/products.json?limit=250&status=archived`),
    shopifyRequest("GET", `/products.json?limit=250&status=draft`),
  ]);
  const all = [...(active.products || []), ...(archived.products || []), ...(draft.products || [])];
  console.log(`📦 Produits: actifs=${active.products?.length} archivés=${archived.products?.length} brouillons=${draft.products?.length} total=${all.length}`);
  return all;
}

async function getShopifyStats() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [orders, active, archived, draft] = await Promise.all([
    shopifyRequest("GET", `/orders.json?limit=250&status=any&created_at_min=${since}`),
    shopifyRequest("GET", `/products.json?limit=250&status=active`),
    shopifyRequest("GET", `/products.json?limit=250&status=archived`),
    shopifyRequest("GET", `/products.json?limit=250&status=draft`),
  ]);
  const totalRevenue = orders.orders.filter(o => o.financial_status === "paid").reduce((sum, o) => sum + parseFloat(o.total_price), 0);
  const total = (active.products?.length || 0) + (archived.products?.length || 0) + (draft.products?.length || 0);
  return {
    orders_30j: orders.orders.length,
    revenue_30j: totalRevenue.toFixed(2),
    products_active: active.products?.length || 0,
    products_archived: archived.products?.length || 0,
    products_draft: draft.products?.length || 0,
    products_total: total,
  };
}

// ═══════════════════════════════
// ACTIONS SHOPIFY — INTERCEPTEUR
// ═══════════════════════════════

// Analyse la réponse de Claude pour détecter une action Shopify
async function detectAndExecuteAction(reply, from) {
  // Format attendu dans la réponse de Claude :
  // [ACTION:update_product:PRODUCT_ID:{"title":"nouveau titre"}]
  // [ACTION:update_price:VARIANT_ID:{"price":"29.99"}]
  const actionRegex = /\[ACTION:(\w+):(\d+):(\{[^}]+\})\]/;
  const match = reply.match(actionRegex);
  if (!match) return null;

  const [, actionType, id, dataStr] = match;
  let actionData;
  try { actionData = JSON.parse(dataStr); } catch { return null; }

  // Sauvegarde l'action en pending
  const preview = `Modifier ${actionType === 'update_price' ? 'prix' : 'produit'} ID ${id} → ${dataStr}`;
  await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`, [from]);
  await pool.query(
    `INSERT INTO pending_actions (user_phone, action_type, action_data, preview) VALUES ($1, $2, $3, $4)`,
    [from, actionType, JSON.stringify({ id, updates: actionData }), preview]
  );

  return preview;
}

async function executeAction(action) {
  const data = typeof action.action_data === 'string' ? JSON.parse(action.action_data) : action.action_data;
  const { id, updates } = data;

  if (action.action_type === 'update_product') {
    await shopifyRequest("PUT", `/products/${id}.json`, { product: { id, ...updates } });
    return `✅ Produit mis à jour avec succès.`;
  }
  if (action.action_type === 'update_price') {
    await shopifyRequest("PUT", `/variants/${id}.json`, { variant: { id, price: updates.price } });
    return `✅ Prix mis à jour : ${updates.price}€`;
  }
  return `❌ Action inconnue`;
}

// ═══════════════════════════════
// COMMANDES RAPIDES
// ═══════════════════════════════
async function handleCommand(command, from) {
  const cmd = command.trim().toLowerCase();

  if (["oui", "confirmer", "ok go", "valider", "yes"].includes(cmd)) {
    const result = await pool.query(
      `SELECT * FROM pending_actions WHERE user_phone = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [from]
    );
    if (result.rows.length > 0) {
      const action = result.rows[0];
      await pool.query(`UPDATE pending_actions SET status = 'confirmed' WHERE id = $1`, [action.id]);
      try { return await executeAction(action); }
      catch (err) { return `❌ Erreur : ${err.message}`; }
    }
    return null;
  }

  if (["non", "annuler", "cancel", "no"].includes(cmd)) {
    await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`, [from]);
    return `🚫 Action annulée.`;
  }

  if (cmd === "/status") {
    const memory = await pool.query(`SELECT key, value, tags FROM memory ORDER BY updated_at DESC`);
    if (memory.rows.length === 0) return "📊 *Status Jarvis*\n\nAucune donnée en mémoire.";
    const byTag = {};
    memory.rows.forEach(r => {
      const tag = r.tags?.split(",")[0] || "general";
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(`• ${r.key}: ${r.value}`);
    });
    let response = "📊 *Status Jarvis*\n\n";
    for (const [tag, items] of Object.entries(byTag)) response += `*${tag.toUpperCase()}*\n${items.join("\n")}\n\n`;
    return response.trim();
  }

  if (cmd === "/memory") {
    const memory = await pool.query(`SELECT key, value, tags, updated_at FROM memory ORDER BY updated_at DESC LIMIT 30`);
    if (memory.rows.length === 0) return "🧠 *Mémoire vide*";
    let response = `🧠 *Mémoire Jarvis (${memory.rows.length} entrées)*\n\n`;
    memory.rows.forEach(r => {
      const date = new Date(r.updated_at).toLocaleDateString("fr-FR");
      response += `[${r.tags || "general"}] *${r.key}*: ${r.value} _(${date})_\n`;
    });
    return response.trim();
  }

  if (cmd === "/clear") {
    await pool.query(`DELETE FROM conversations WHERE user_phone = $1`, [ALLOWED_NUMBER]);
    return "🗑️ Historique effacé.";
  }

  if (cmd === "/stats" || cmd === "/shopify") {
    try {
      const stats = await getShopifyStats();
      return `📊 *DodoDog — Stats 30 jours*\n\n• Commandes : ${stats.orders_30j}\n• Revenus : ${stats.revenue_30j}€\n• Actifs : ${stats.products_active} | Archivés : ${stats.products_archived} | Brouillons : ${stats.products_draft}`;
    } catch (err) { return `❌ Erreur Shopify : ${err.message}`; }
  }

  if (cmd === "/commandes") {
    try {
      const orders = await getShopifyOrders(5);
      if (orders.length === 0) return "📦 Aucune commande récente.";
      let response = `📦 *5 dernières commandes*\n\n`;
      orders.forEach(o => {
        const date = new Date(o.created_at).toLocaleDateString("fr-FR");
        response += `• ${date} — ${o.total_price}€ — ${o.financial_status}\n`;
      });
      return response.trim();
    } catch (err) { return `❌ Erreur : ${err.message}`; }
  }

  if (cmd === "/produits") {
    try {
      const products = await getShopifyProducts();
      let response = `🛍️ *Produits DodoDog (${products.length})*\n\n`;
      products.slice(0, 15).forEach(p => {
        const icon = p.status === "active" ? "✅" : p.status === "archived" ? "📦" : "📝";
        response += `${icon} ${p.title} — ${p.variants[0]?.price}€\n`;
      });
      if (products.length > 15) response += `\n_...et ${products.length - 15} autres_`;
      return response.trim();
    } catch (err) { return `❌ Erreur : ${err.message}`; }
  }

  if (cmd === "/help") {
    return `🤖 *Commandes Jarvis*\n\n*Shopify*\n/stats — stats 30 jours\n/commandes — 5 dernières commandes\n/produits — liste des produits\n\n*Mémoire*\n/status — mémoire par boutique\n/memory — tout ce que je sais\n/clear — efface l'historique\n\n*Validation*\noui — valide une action\nnon — annule une action\n\nTu peux aussi m'envoyer des 📸 photos !`;
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
  const imageResponse = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
  });
  const base64Image = Buffer.from(imageResponse.data).toString("base64");
  const response = await anthropic.messages.create({
    model: MODEL_SONNET, max_tokens: 1024, system: systemWithMemory,
    messages: [...history, {
      role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
        { type: "text", text: caption || "Analyse cette image en lien avec mon business." },
      ]
    }]
  });
  return response.content[0].text;
}

// ═══════════════════════════════
// ENVOI WHATSAPP
// ═══════════════════════════════
async function sendWhatsApp(to, body) {
  const maxLength = 1600;
  const parts = [];
  for (let i = 0; i < body.length; i += maxLength) parts.push(body.slice(i, i + maxLength));
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
const JARVIS_SYSTEM = `Tu es Jarvis, l'assistant personnel IA d'Alexis San Jose, entrepreneur e-commerce basé en Gironde, France. Tu gères tout son business de A à Z.

Tu as un ACCÈS API COMPLET à Shopify DodoDog — lecture ET écriture. Tu peux modifier les produits, prix, descriptions directement.

═══════════════════════════════
COMMENT EXÉCUTER DES ACTIONS SHOPIFY
═══════════════════════════════
Pour modifier un produit, tu dois d'abord récupérer son ID via /produits, puis inclure dans ta réponse un bloc d'action au format exact :

Pour modifier le titre ou la description :
[ACTION:update_product:PRODUCT_ID:{"title":"nouveau titre"}]

Pour modifier un prix (utilise l'ID du variant, pas du produit) :
[ACTION:update_price:VARIANT_ID:{"price":"29.99"}]

RÈGLES OBLIGATOIRES :
1. Toujours montrer l'aperçu de la modification AVANT d'inclure le bloc ACTION
2. Attendre "oui" d'Alexis avant que l'action soit exécutée
3. Pour les modifications en masse : tester sur 1 produit, attendre "confirmer tout"
4. Ne JAMAIS inclure le bloc [ACTION:...] sans avoir proposé la modification d'abord
5. Toujours préciser l'ID du produit/variant concerné

Exemple correct :
"Je vais modifier le prix du Panier L (variant ID 12345) de 29€ à 35€. Tu confirmes ?"
[ACTION:update_price:12345:{"price":"35.00"}]

═══════════════════════════════
BOUTIQUE 1 — DODODOG (dododog.fr)
═══════════════════════════════
Niche : accessoires et couchage chiens premium, marché français
Produits : actifs + archivés + brouillons accessibles via API
Campagne Google Ads : PMax feed only, budget 15€/jour
GMC : 230 fiches validées
Correspondance tailles/races :
  - S → Chihuahua | M → Beagle/Border Collie | L → Berger Australien | XL → Labrador
Charte : fond blanc #FFFFFF, terracotta #D26046, dark #1A1A1B, Josefin Sans
Code promo panier abandonné : DOG10

═══════════════════════════════
BOUTIQUE 2 — VERANO LUMIÈRE PARIS
═══════════════════════════════
Niche : luminaires design, marché français premium
Charte : bronze #A8815C, fond blanc, minimaliste luxe

═══════════════════════════════
BOUTIQUE 3 — VELLURE
═══════════════════════════════
Statut : repositionnement niche mono mot-clé à définir

═══════════════════════════════
BOUTIQUE 4 — DODOBABY
═══════════════════════════════
Statut : en construction, niche bébé/poussette

═══════════════════════════════
RÈGLES ABSOLUES
═══════════════════════════════
1. Toujours répondre en français
2. Proposer avant d'exécuter — jamais d'action sans confirmation
3. Actions simples → confirmation oui/non
4. Actions risquées → double confirmation
5. Concis et actionnable
6. Mémoire persistante — utilise-la
7. Urgence → 🚨 en priorité absolue`;

// ═══════════════════════════════
// WEBHOOK
// ═══════════════════════════════
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body || "";
  const messageSid = req.body.MessageSid;
  const numMedia = parseInt(req.body.NumMedia || "0");

  if (!from || (text.trim().length === 0 && numMedia === 0)) return res.status(200).send('');

  if (!validateTwilioSignature(req)) {
    console.warn(`⚠️ Signature invalide (${from})`);
    return res.status(403).send('Forbidden');
  }

  if (from !== ALLOWED_NUMBER) {
    console.warn(`⚠️ Numéro non autorisé (${from})`);
    return res.status(200).send('');
  }

  if (from === `whatsapp:${process.env.TWILIO_NUMBER}`) return res.status(200).send('');

  const alreadyDone = await isAlreadyProcessed(messageSid);
  if (alreadyDone) return res.status(200).send('');

  if (isUrgent(text)) console.log(`🚨 URGENCE: ${text}`);
  console.log(`📩 ${from}: ${text || "[image]"}`);

  // Réponse immédiate à Twilio
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

    // Injecte données Shopify si pertinent
    let shopifyContext = "";
    const shopifyKeywords = ["commande", "vente", "produit", "stock", "prix", "revenu", "chiffre", "boutique", "shopify", "modifie", "modifier", "change"];
    if (shopifyKeywords.some(k => text.toLowerCase().includes(k))) {
      try {
        const stats = await getShopifyStats();
        shopifyContext = `\n\n═══════════════════════════════\nDONNÉES SHOPIFY DODODOG (TEMPS RÉEL)\n═══════════════════════════════\nCommandes (30j): ${stats.orders_30j} | Revenu: ${stats.revenue_30j}€\nProduits: ${stats.products_active} actifs, ${stats.products_archived} archivés, ${stats.products_draft} brouillons`;
      } catch (err) {
        console.error("Stats Shopify:", err.message);
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
      const model = selectModel(text);
      const response = await anthropic.messages.create({
        model, max_tokens: 1024, system: systemWithMemory, messages: history,
      });
      reply = response.content[0].text;
    }

    await saveMessage(from, "assistant", reply);

    // Détecte et prépare une action Shopify si Claude en a inclus une
    const actionPreview = await detectAndExecuteAction(reply, from);

    // Nettoie le bloc [ACTION:...] de la réponse avant envoi
    const cleanReply = reply.replace(/\[ACTION:[^\]]+\]/g, "").trim();

    await sendWhatsApp(from, cleanReply);

    // Mémoire auto (sans bloquer)
    const manualTrigger = ["retiens", "souviens", "note que", "mémorise"];
    if (manualTrigger.some(t => text.toLowerCase().includes(t))) {
      saveMemory(`note_${Date.now()}`, text, "manuel").catch(() => {});
    }

  } catch (err) {
    console.error("Erreur webhook:", err.message);
    if (err.status !== 429) {
      await sendWhatsApp(from, `❌ Erreur : ${err.message}`).catch(() => {});
    }
  }
});

// Route de test Shopify
app.get("/test-shopify", async (req, res) => {
  try {
    const token = await getShopifyToken();
    const count = await axios.get(`https://${SHOPIFY_SHOP}/admin/api/2024-01/products/count.json`, {
      headers: { "X-Shopify-Access-Token": token }
    });
    res.json({ token: token.slice(0, 10) + "...", shop: SHOPIFY_SHOP, count: count.data });
  } catch (err) {
    res.json({ error: err.response?.data || err.message });
  }
});

app.get("/", (req, res) => res.send("Jarvis est en ligne ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Jarvis démarré sur le port ${PORT}`);
  console.log(`Shopify auth: ${APP_URL}/auth`);
});
