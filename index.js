require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();

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
Séquence email panier abandonné : 3 emails avec code DOG10
Boutique Etsy : DodoDogFR

═══════════════════════════════
BOUTIQUE 2 — VERANO LUMIÈRE PARIS (veranolumiereparis.fr)
═══════════════════════════════
Niche : luminaires design, marché français premium
Catalogue : Lustres, Suspensions, Plafonniers, Appliques Murales, Lampadaires, Lampes de Table
Styles : Moderne, Scandinave, Industriel, Minimaliste, Vintage
Matières : Bois, Métal, Verre, Rotin
Statut : rouvert la semaine dernière, GMC 360 fiches en stock limité en attente de validation
Produits via DSers (liens fournisseurs perdus lors de la coupure)
Charte graphique : bronze #A8815C, fond blanc #FFFFFF, dark #1A1A1B, minimaliste luxe

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
7. Ne jamais redemander des infos déjà connues`;

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body;
  
  if (!from || !text) return res.sendStatus(200);
  
  console.log(`Message de ${from}: ${text}`);

  if (!conversations.has(from)) conversations.set(from, []);
  const history = conversations.get(from);
  history.push({ role: "user", content: text });
  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: JARVIS_SYSTEM,
      messages: history,
    });

    const reply = response.content[0].text;
    history.push({ role: "assistant", content: reply });

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
app.listen(PORT, () => console.log(`Jarvis démarré sur le port ${PORT}`));
