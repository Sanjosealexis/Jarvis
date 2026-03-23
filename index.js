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
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_sid VARCHAR(100) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Base de données initialisée ✅");
}

// Historique réduit à 10 messages
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

// Mémoire long terme plafonnée à 20 entrées
async function getMemory() {
  const result = await pool.query(`SELECT key, value FROM memory ORDER BY updated_at DESC LIMIT 20`);
  return result.rows.map(r => `${r.key}: ${r.value}`).join("\n");
}

async function saveMemory(key, value) {
  // Vérifie si on dépasse 20 entrées → supprime la plus ancienne
  const count = await pool.query(`SELECT COUNT(*) FROM memory`);
  if (parseInt(count.rows[0].count) >= 20) {
    await pool.query(`DELETE FROM memory WHERE id = (SELECT id FROM memory ORDER BY updated_at ASC LIMIT 1)`);
  }
  await pool.query(
    `INSERT INTO memory (key, value) 
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

// Déduplication : vérifie si le message a déjà été traité
async function isAlreadyProcessed(messageSid) {
  if (!messageSid) return false;
  try {
    const result = await pool.query(
      `INSERT INTO processed_messages (message_sid) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_sid`,
      [messageSid]
    );
    return result.rows.length === 0; // Si rien inséré = déjà traité
  } catch {
    return false;
  }
}

// ═══════════════════════════════
// DÉTECTION MÉMOIRE AUTOMATIQUE
// ═══════════════════════════════
async function detectAndSaveMemory(userText, assistantReply) {
  // Manuel : si l'utilisateur demande explicitement
  const manualTrigger = ["retiens", "souviens", "note que", "mémorise", "n'oublie pas"];
  if (manualTrigger.some(t => userText.toLowerCase().includes(t))) {
    await saveMemory(`note_${Date.now()}`, userText);
    console.log("Mémoire sauvegardée (manuel)");
    return;
  }

  // Automatique : on demande à Claude si c'est important à retenir
  try {
    const check = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Message utilisateur: "${userText}"
Réponse assistant: "${assistantReply}"

Est-ce que cet échange contient une information importante à mémoriser sur l'utilisateur ou son business (décision stratégique, donnée clé, changement de situation) ?
Si oui, réponds UNIQUEMENT avec: MEMORISER|clé_courte|valeur_à_retenir
Si non, réponds UNIQUEMENT avec: IGNORER`
      }]
    });

    const decision = check.content[0].text.trim();
    if (decision.startsWith("MEMORISER|")) {
      const parts = decision.split("|");
      if (parts.length === 3) {
        await saveMemory(parts[1], parts[2]);
        console.log(`Mémoire sauvegardée (auto): ${parts[1]} = ${parts[2]}`);
      }
    }
  } catch (err) {
    console.error("Erreur détection mémoire auto:", err.message);
  }
}

// ═══════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════
const JARVIS_SYSTEM = `Tu es Jarvis, l'assistant personnel IA d'Alexis San Jose, entrepreneur e-commerce basé en Gironde, France. Tu gères tout son business de A à Z. Tu es son bras droit opérationnel.

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
Catalogue : Lustres, Suspensions, Plafonniers, Appliques Murales, Lampadaires, Lampes de Table
Styles : Moderne, Scandinave, Industriel, Minimaliste, Vintage — Matières : Bois, Métal, Verre, Rotin
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
Shopify, Google Ads, GMC, Simprosys, DSers, Nano Banana Pro 2

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
9. Si tu apprends quelque chose d'important sur Alexis ou son business, mémorise-le`;

// ═══════════════════════════════
// WEBHOOK
// ═══════════════════════════════
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body;
  const messageSid = req.body.MessageSid;

  // Body vide ou absent = callback de statut Twilio → ignorer
  if (!from || !text || text.trim().length === 0) return res.status(200).send('');

  // ── SÉCURITÉ 1 : Validation signature Twilio ──
  if (!validateTwilioSignature(req)) {
    console.warn(`⚠️ Requête rejetée : signature Twilio invalide (from: ${from})`);
    return res.status(403).send('Forbidden');
  }

  // ── SÉCURITÉ 2 : Whitelist numéro ──
  if (from !== ALLOWED_NUMBER) {
    console.warn(`⚠️ Accès refusé : numéro non autorisé (${from})`);
    return res.status(200).send('');
  }

  // Ignorer les messages de notre propre numéro Twilio
  if (from === `whatsapp:${process.env.TWILIO_NUMBER}`) return res.status(200).send('');

  // ── DÉDUPLICATION ──
  const alreadyDone = await isAlreadyProcessed(messageSid);
  if (alreadyDone) {
    console.log(`Message déjà traité, ignoré: ${messageSid}`);
    return res.status(200).send('');
  }

  console.log(`Message de ${from}: ${text}`);

  try {
    const history = await getHistory(from);
    const longTermMemory = await getMemory();

    await saveMessage(from, "user", text);
    history.push({ role: "user", content: text });

    const systemWithMemory = JARVIS_SYSTEM +
      (longTermMemory ? `\n\n═══════════════════════════════\nMÉMOIRE LONG TERME\n═══════════════════════════════\n${longTermMemory}` : "");

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemWithMemory,
      messages: history,
    });

    const reply = response.content[0].text;
    await saveMessage(from, "assistant", reply);

    // Détection mémoire : manuelle + automatique
    await detectAndSaveMemory(text, reply);

    // Envoi WhatsApp via Twilio
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
      new URLSearchParams({
        From: `whatsapp:${process.env.TWILIO_NUMBER}`,
        To: from,
        Body: reply,
      }),
      {
        auth: {
          username: process.env.TWILIO_SID,
          password: process.env.TWILIO_TOKEN,
        },
      }
    );

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
