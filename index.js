require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Connexion base de données
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway.internal") ? false : { rejectUnauthorized: false }
});

// Création des tables au démarrage
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
  `);
  console.log("Base de données initialisée ✅");
}

// Récupère les 20 derniers messages d'un utilisateur
async function getHistory(phone) {
  const result = await pool.query(
    `SELECT role, content FROM conversations 
     WHERE user_phone = $1 
     ORDER BY created_at DESC LIMIT 20`,
    [phone]
  );
  return result.rows.reverse();
}

// Sauvegarde un message
async function saveMessage(phone, role, content) {
  await pool.query(
    `INSERT INTO conversations (user_phone, role, content) VALUES ($1, $2, $3)`,
    [phone, role, content]
  );
}

// Récupère la mémoire long terme
async function getMemory() {
  const result = await pool.query(`SELECT key, value FROM memory`);
  return result.rows.map(r => `${r.key}: ${r.value}`).join("\n");
}

// Sauvegarde un élément de mémoire
async function saveMemory(key, value) {
  await pool.query(
    `INSERT INTO memory (key, value) 
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

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

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body;
  if (!from || !text) return res.sendStatus(200);

  console.log(`Message de ${from}: ${text}`);

  try {
    // Récupère l'historique depuis la BDD
    const history = await getHistory(from);
    const longTermMemory = await getMemory();

    // Sauvegarde le message utilisateur
    await saveMessage(from, "user", text);
    history.push({ role: "user", content: text });

    // Système enrichi avec mémoire long terme
    const systemWithMemory = JARVIS_SYSTEM + 
      (longTermMemory ? `\n\n═══════════════════════════════\nMÉMOIRE LONG TERME\n═══════════════════════════════\n${longTermMemory}` : "");

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemWithMemory,
      messages: history,
    });

    const reply = response.content[0].text;

    // Sauvegarde la réponse
    await saveMessage(from, "assistant", reply);

    // Détection automatique d'infos à mémoriser
    if (text.toLowerCase().includes("retiens") || text.toLowerCase().includes("souviens") || text.toLowerCase().includes("note que")) {
      await saveMemory(`note_${Date.now()}`, text);
    }

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

    res.sendStatus(200);
  } catch (err) {
    console.error("Erreur:", err.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Jarvis est en ligne ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Jarvis démarré sur le port ${PORT}`);
});
