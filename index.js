require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");
const twilio = require("twilio");

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
    "analyse", "analyser", "analysons",
    "stratégie", "stratégique",
    "rédige", "rédiger", "écris", "propose",
    "optimise", "optimiser",
    "campagne", "performance", "résultat",
    "plan", "planning", "compare", "comparaison",
    "explique", "comment faire", "aide moi à",
    "diagnostic", "problème", "améliore", "améliorer",
    "crée", "créer", "génère", "rapport", "bilan",
    "description produit", "fiche produit",
    "email", "mail", "pourquoi", "comment se fait"
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
  `);
  await pool.query(`ALTER TABLE memory ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '';`);
  console.log("Base de données initialisée ✅");
}

async function getHistory(phone) {
  const result = await pool.query(
    `SELECT role, content FROM conversations 
     WHERE user_phone = $1 
     ORDER BY created_at DESC LIMIT 10`,
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
// MÉMOIRE INFINIE PAR TAGS
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
    const tagValues = matchedTags.map(t => `%${t}%`);
    result = await pool.query(
      `SELECT key, value FROM memory WHERE ${tagConditions} ORDER BY updated_at DESC LIMIT 10`,
      tagValues
    );
    if (result.rows.length < 5) {
      const extra = await pool.query(
        `SELECT key, value FROM memory WHERE tags = '' OR tags IS NULL ORDER BY updated_at DESC LIMIT 5`
      );
      result.rows = [...result.rows, ...extra.rows];
    }
  } else {
    result = await pool.query(`SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 10`);
  }
  return result.rows.map(r => `${r.key}: ${r.value}`).join("\n");
}

async function saveMemory(key, value, tags = "") {
  await pool.query(
    `INSERT INTO memory (key, value, tags) 
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, tags = $3, updated_at = NOW()`,
    [key, value, tags]
  );
  console.log(`💾 Mémoire sauvegardée: [${tags}] ${key} = ${value}`);
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
// DÉTECTION MÉMOIRE AUTO
// ═══════════════════════════════
async function detectAndSaveMemory(userText, assistantReply) {
  const manualTrigger = ["retiens", "souviens", "note que", "mémorise", "n'oublie pas"];
  if (manualTrigger.some(t => userText.toLowerCase().includes(t))) {
    await saveMemory(`note_${Date.now()}`, userText, "manuel");
    return;
  }
  try {
    const check = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Message: "${userText}"
Réponse: "${assistantReply}"

Est-ce que cet échange contient une info importante à mémoriser (décision, chiffre clé, changement de situation, préférence) ?
Si oui: MEMORISER|clé_courte|valeur_à_retenir|tag1,tag2,tag3
Tags possibles: dododog, verano, vellure, dodobaby, google_ads, gmc, shopify, finance, simprosys, dsers, general
Si non: IGNORER`
      }]
    });
    const decision = check.content[0].text.trim();
    if (decision.startsWith("MEMORISER|")) {
      const parts = decision.split("|");
      if (parts.length === 4) await saveMemory(parts[1], parts[2], parts[3]);
    }
  } catch (err) {
    console.error("Erreur détection mémoire auto:", err.message);
  }
}

// ═══════════════════════════════
// SHOPIFY API — DODODOG
// ═══════════════════════════════
const SHOPIFY_DODODOG = {
  url: process.env.SHOPIFY_DODODOG_URL,
  token: process.env.SHOPIFY_DODODOG_TOKEN,
};

async function shopifyRequest(method, endpoint, data = null) {
  const url = `https://${SHOPIFY_DODODOG.url}/admin/api/2024-01${endpoint}`;
  const [clientId, clientSecret] = SHOPIFY_DODODOG.token.split(":");
  const config = {
    method,
    url,
    headers: { "Content-Type": "application/json" },
    auth: {
      username: clientId,
      password: clientSecret,
    },
  };
  if (data) config.data = data;
  const response = await axios(config);
  return response.data;
}

async function getShopifyOrders(limit = 10) {
  const data = await shopifyRequest("GET", `/orders.json?limit=${limit}&status=any`);
  return data.orders;
}

async function getShopifyProducts() {
  const data = await shopifyRequest("GET", `/products.json?limit=250`);
  return data.products;
}

async function getShopifyStats() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [orders, products] = await Promise.all([
    shopifyRequest("GET", `/orders.json?limit=250&status=any&created_at_min=${since}`),
    shopifyRequest("GET", `/products.json?limit=250`),
  ]);
  const totalRevenue = orders.orders
    .filter(o => o.financial_status === "paid")
    .reduce((sum, o) => sum + parseFloat(o.total_price), 0);
  return {
    orders_30j: orders.orders.length,
    revenue_30j: totalRevenue.toFixed(2),
    products_total: products.products.length,
    products_active: products.products.filter(p => p.status === "active").length,
  };
}

// ═══════════════════════════════
// SYSTÈME DE VALIDATION — DOUBLE CONFIRMATION
// ═══════════════════════════════
async function createPendingAction(phone, actionType, actionData, preview) {
  await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`, [phone]);
  const result = await pool.query(
    `INSERT INTO pending_actions (user_phone, action_type, action_data, preview) VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, actionType, JSON.stringify(actionData), preview]
  );
  return result.rows[0].id;
}

async function getPendingAction(phone) {
  const result = await pool.query(
    `SELECT * FROM pending_actions WHERE user_phone = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

async function confirmPendingAction(phone) {
  const action = await getPendingAction(phone);
  if (!action) return null;
  await pool.query(`UPDATE pending_actions SET status = 'confirmed' WHERE id = $1`, [action.id]);
  return action;
}

async function cancelPendingAction(phone) {
  await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`, [phone]);
}

async function executeShopifyAction(action) {
  const data = typeof action.action_data === 'string' ? JSON.parse(action.action_data) : action.action_data;

  switch (action.action_type) {
    case "update_product": {
      await shopifyRequest("PUT", `/products/${data.product_id}.json`, { product: data.updates });
      return `✅ Produit mis à jour avec succès.`;
    }
    case "update_price": {
      await shopifyRequest("PUT", `/variants/${data.variant_id}.json`, {
        variant: { id: data.variant_id, price: data.new_price }
      });
      return `✅ Prix mis à jour : ${data.new_price}€`;
    }
    default:
      return `❌ Action inconnue : ${action.action_type}`;
  }
}

// ═══════════════════════════════
// COMMANDES RAPIDES
// ═══════════════════════════════
async function handleCommand(command, from) {
  const cmd = command.trim().toLowerCase();

  if (cmd === "oui" || cmd === "confirmer" || cmd === "ok go" || cmd === "valider") {
    const action = await confirmPendingAction(from);
    if (action) {
      console.log(`✅ Action confirmée: ${action.action_type}`);
      try {
        return await executeShopifyAction(action);
      } catch (err) {
        return `❌ Erreur lors de l'exécution : ${err.message}`;
      }
    }
    return null;
  }

  if (cmd === "non" || cmd === "annuler" || cmd === "cancel") {
    await cancelPendingAction(from);
    return `🚫 Action annulée. Aucune modification effectuée.`;
  }

  if (cmd === "/status") {
    const memory = await pool.query(`SELECT key, value, tags FROM memory ORDER BY updated_at DESC`);
    if (memory.rows.length === 0) return "📊 *Status Jarvis*\n\nAucune donnée en mémoire pour l'instant.";
    const byTag = {};
    memory.rows.forEach(r => {
      const tag = r.tags?.split(",")[0] || "general";
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(`• ${r.key}: ${r.value}`);
    });
    let response = "📊 *Status Jarvis*\n\n";
    for (const [tag, items] of Object.entries(byTag)) {
      response += `*${tag.toUpperCase()}*\n${items.join("\n")}\n\n`;
    }
    return response.trim();
  }

  if (cmd === "/memory") {
    const memory = await pool.query(`SELECT key, value, tags, updated_at FROM memory ORDER BY updated_at DESC LIMIT 30`);
    if (memory.rows.length === 0) return "🧠 *Mémoire vide*\n\nJe n'ai encore rien mémorisé.";
    let response = `🧠 *Mémoire Jarvis (${memory.rows.length} entrées)*\n\n`;
    memory.rows.forEach(r => {
      const date = new Date(r.updated_at).toLocaleDateString("fr-FR");
      response += `[${r.tags || "general"}] *${r.key}*: ${r.value} _(${date})_\n`;
    });
    return response.trim();
  }

  if (cmd === "/clear") {
    await pool.query(`DELETE FROM conversations WHERE user_phone = $1`, [ALLOWED_NUMBER]);
    return "🗑️ Historique effacé. On repart de zéro !";
  }

  if (cmd === "/stats" || cmd === "/shopify") {
    try {
      const stats = await getShopifyStats();
      return `📊 *DodoDog — Stats 30 jours*\n\n• Commandes : ${stats.orders_30j}\n• Revenus : ${stats.revenue_30j}€\n• Produits actifs : ${stats.products_active}/${stats.products_total}`;
    } catch (err) {
      return `❌ Erreur Shopify : ${err.message}`;
    }
  }

  if (cmd === "/commandes") {
    try {
      const orders = await getShopifyOrders(5);
      if (orders.length === 0) return "📦 Aucune commande récente.";
      let response = `📦 *5 dernières commandes DodoDog*\n\n`;
      orders.forEach(o => {
        const date = new Date(o.created_at).toLocaleDateString("fr-FR");
        response += `• ${date} — ${o.total_price}€ — ${o.financial_status} — ${o.email || "sans email"}\n`;
      });
      return response.trim();
    } catch (err) {
      return `❌ Erreur Shopify : ${err.message}`;
    }
  }

  if (cmd === "/produits") {
    try {
      const products = await getShopifyProducts();
      let response = `🛍️ *Produits DodoDog (${products.length})*\n\n`;
      products.slice(0, 15).forEach(p => {
        response += `• ${p.title} — ${p.status} — ${p.variants[0]?.price}€\n`;
      });
      if (products.length > 15) response += `\n_...et ${products.length - 15} autres_`;
      return response.trim();
    } catch (err) {
      return `❌ Erreur Shopify : ${err.message}`;
    }
  }

  if (cmd === "/help") {
    return `🤖 *Commandes Jarvis*\n\n*Info*\n/stats — stats DodoDog 30 jours\n/commandes — 5 dernières commandes\n/produits — liste des produits\n/status — mémoire par boutique\n/memory — tout ce que je sais\n\n*Gestion*\n/clear — efface l'historique\n\n*Validation*\noui / confirmer — valide une action\nnon / annuler — annule une action\n\nTu peux aussi m'envoyer des 📸 photos !`;
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
  if (!mediaType?.startsWith("image/")) return "Je ne peux traiter que des images pour l'instant.";

  console.log(`🖼️ Image reçue: ${mediaType}`);
  const imageResponse = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
  });
  const base64Image = Buffer.from(imageResponse.data).toString("base64");
  const userMessage = {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: caption || "Analyse cette image et dis-moi ce que tu vois en lien avec mon business." },
    ],
  };
  const response = await anthropic.messages.create({
    model: MODEL_SONNET,
    max_tokens: 1024,
    system: systemWithMemory,
    messages: [...history, userMessage],
  });
  console.log(`🧠 Modèle: Sonnet (analyse image)`);
  return response.content[0].text;
}

// ═══════════════════════════════
// ENVOI WHATSAPP
// ═══════════════════════════════
async function sendWhatsApp(to, body) {
  const maxLength = 1600;
  if (body.length > maxLength) {
    const parts = [];
    for (let i = 0; i < body.length; i += maxLength) parts.push(body.slice(i, i + maxLength));
    for (const part of parts) {
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
        new URLSearchParams({ From: `whatsapp:${process.env.TWILIO_NUMBER}`, To: to, Body: part }),
        { auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN } }
      );
      await new Promise(r => setTimeout(r, 500));
    }
    return;
  }
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
    new URLSearchParams({ From: `whatsapp:${process.env.TWILIO_NUMBER}`, To: to, Body: body }),
    { auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN } }
  );
}

// ═══════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════
const JARVIS_SYSTEM = `Tu es Jarvis, l'assistant personnel IA d'Alexis San Jose, entrepreneur e-commerce basé en Gironde, France. Tu gères tout son business de A à Z. Tu es son bras droit opérationnel.

Tu as accès à l'API Shopify de DodoDog en lecture et en écriture.

═══════════════════════════════
RÈGLES DE VALIDATION OBLIGATOIRES
═══════════════════════════════
AVANT toute modification Shopify, tu dois TOUJOURS :
1. PROPOSER ce que tu vas faire avec un aperçu clair
2. Attendre la confirmation "oui" ou "confirmer" d'Alexis
3. Pour les modifications en masse : appliquer d'abord sur 1 seul produit test, montrer le résultat, attendre "confirmer tout"
4. Pour les actions risquées : demander une double confirmation explicite
Tu ne modifies JAMAIS Shopify sans confirmation explicite d'Alexis.

═══════════════════════════════
BOUTIQUE 1 — DODODOG (dododog.fr)
═══════════════════════════════
Niche : accessoires et couchage chiens premium, marché français
Produits : 23 produits actifs — paniers, lits, tapis (en pub) + harnais, colliers, accessoires (pas en pub)
Fournisseurs : DSers (AliExpress) + scraping concurrent
Campagne Google Ads : PMax feed only, budget 15€/jour
GMC : 230 fiches validées, statut En stock
Gestion flux : Simprosys + custom labels
Correspondance tailles/races :
  - S → Chihuahua
  - M → Beagle / Border Collie
  - L → Berger Australien
  - XL → Labrador / Golden Retriever
Charte graphique : fond blanc #FFFFFF, terracotta #D26046, dark #1A1A1B, font Josefin Sans
Code promo panier abandonné : DOG10
Boutique Etsy : DodoDogFR

═══════════════════════════════
BOUTIQUE 2 — VERANO LUMIÈRE PARIS (veranolumiereparis.fr)
═══════════════════════════════
Niche : luminaires design, marché français premium
Statut : rouvert récemment, GMC 360 fiches en stock limité en attente de validation
Charte graphique : bronze #A8815C, fond blanc #FFFFFF, minimaliste luxe

═══════════════════════════════
BOUTIQUE 3 — VELLURE
═══════════════════════════════
Statut : repositionnement sur nouvelle niche mono mot-clé à définir

═══════════════════════════════
BOUTIQUE 4 — DODOBABY
═══════════════════════════════
Statut : en construction, niche bébé/poussette, marché français

═══════════════════════════════
OUTILS
═══════════════════════════════
Shopify (accès API DodoDog actif), Google Ads, GMC, Simprosys, DSers, Nano Banana Pro 2

═══════════════════════════════
RÈGLES ABSOLUES
═══════════════════════════════
1. Toujours répondre en français
2. Toujours proposer avant d'exécuter
3. Actions simples → confirmation oui/non
4. Actions risquées → double confirmation
5. Actions lecture seule → réponse directe
6. Concis et actionnable, jamais de blabla
7. Ne jamais redemander des infos déjà connues
8. Tu as une mémoire persistante — utilise-la pour t'améliorer continuellement
9. Si tu apprends quelque chose d'important sur Alexis ou son business, mémorise-le
10. En cas d'urgence détectée, réponds en priorité absolue avec 🚨 en début de message`;

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
  if (alreadyDone) {
    console.log(`Message déjà traité: ${messageSid}`);
    return res.status(200).send('');
  }

  if (isUrgent(text)) console.log(`🚨 URGENCE détectée: ${text}`);
  console.log(`📩 Message de ${from}: ${text || "[image]"}`);

  try {
    // ── COMMANDES RAPIDES + VALIDATION ──
    const cmdReply = await handleCommand(text, from);
    if (cmdReply) {
      await saveMessage(from, "user", text);
      await saveMessage(from, "assistant", cmdReply);
      await sendWhatsApp(from, cmdReply);
      return res.status(200).send('');
    }

    const history = await getHistory(from);
    const relevantMemory = await getRelevantMemory(text);

    // Injecte les données Shopify si la question concerne la boutique
    let shopifyContext = "";
    const shopifyKeywords = ["commande", "vente", "produit", "stock", "prix", "revenu", "chiffre", "boutique", "shopify"];
    if (shopifyKeywords.some(k => text.toLowerCase().includes(k))) {
      try {
        const stats = await getShopifyStats();
        shopifyContext = `\n\n═══════════════════════════════\nDONNÉES SHOPIFY DODODOG EN TEMPS RÉEL\n═══════════════════════════════\nCommandes (30j): ${stats.orders_30j}\nRevenu (30j): ${stats.revenue_30j}€\nProduits actifs: ${stats.products_active}/${stats.products_total}`;
      } catch (err) {
        console.error("Erreur stats Shopify:", err.message);
      }
    }

    const systemWithMemory = JARVIS_SYSTEM +
      (relevantMemory ? `\n\n═══════════════════════════════\nMÉMOIRE PERTINENTE\n═══════════════════════════════\n${relevantMemory}` : "") +
      shopifyContext;

    let reply;

    if (numMedia > 0) {
      await saveMessage(from, "user", `[Image envoyée] ${text}`);
      reply = await handleImageMessage(req, history, systemWithMemory);
    } else {
      await saveMessage(from, "user", text);
      history.push({ role: "user", content: text });
      const model = selectModel(text);
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: 1024,
        system: systemWithMemory,
        messages: history,
      });
      reply = response.content[0].text;
    }

    await saveMessage(from, "assistant", reply);
    detectAndSaveMemory(text, reply).catch(err => console.error("Mémoire auto:", err.message));
    await sendWhatsApp(from, reply);
    res.status(200).send('');

  } catch (err) {
    console.error("Erreur:", err.message);
    res.status(200).send('');
  }
});

app.get("/", (req, res) => res.send("Jarvis est en ligne ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Jarvis démarré sur le port ${PORT}`);
});
