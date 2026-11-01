<div align="center">

# 📂 AI Folder Sync

**Work locally in your project folder with any AI assistant — 100% in your browser.**  
*Werk lokaal in je eigen projectmap met élke AI-assistent — 100% in je browser.*

[![🚀 Launch Live Tool](https://img.shields.io/badge/🚀_Open_Live_Tool-AI_Folder_Sync-2563eb?style=for-the-badge)](https://ivannijdam08-web.github.io/ai-folder-sync/)
[![Privacy](https://img.shields.io/badge/Privacy-100%25_Local-10b981?style=for-the-badge)](#requirements--privacy)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome_%7C_Edge_%7C_Brave-6366f1?style=for-the-badge)](#requirements--privacy)

### 🌐 Language / Taal
[**🇬🇧 English Documentation**](#english) &nbsp;•&nbsp; [**🇳🇱 Nederlandse Documentatie**](#nederlands)

</div>

---

<a id="english"></a>

## 🇬🇧 English

### 1. Short Introduction
**AI Folder Sync** bridges the gap between your local files and any web-based AI assistant (such as ChatGPT, Claude, Gemini, or DeepSeek). Link your local project folder, copy your project structure, code, and prompt in one click, and write the AI's JSON response from your clipboard directly back to your hard drive—without manually creating, copying, or pasting individual files.

### 2. Live Tool
👉 **Open the tool directly in your browser:**  
### [**https://ivannijdam08-web.github.io/ai-folder-sync/**](https://ivannijdam08-web.github.io/ai-folder-sync/)
*(No installation, account, or API key required.)*

### 3. Key Features
* **📂 Local Folder & File Explorer:** Link any existing project folder—or an empty folder to start a project from scratch—and view a clean, hierarchical file tree with file sizes, line counts, and selective file checkboxes.
* **📋 Full Project Export (New Chat):** Copy your complete folder structure, all selected source files, your task prompt, and the master AI system instructions to your clipboard in one click (or download as `.txt`).
* **🔄 Live Auto-Sync & Delta Detection (Ongoing Chat):** Automatically watches your local folder in the background for external edits made in VS Code or File Explorer. Use **Sync + prompt** to send *only* your manually added, modified, or deleted files so the AI updates its memory without re-uploading your entire codebase.
* **💬 Prompt-Only Mode:** Quickly copy a lightweight follow-up instruction with a compact JSON format reminder when no local files have been edited manually.
* **⚡ 1-Click Clipboard Updater & Smart Diffs:** Reads the AI's JSON block directly from your clipboard and executes file creations (`files`), folder creations (`folders`), file moves/renames (`move`), deletions (`delete`), and targeted search-and-replace blocks (`edit`) using 3-layer whitespace-tolerant matching.
* **📌 Floating Picture-in-Picture Panel:** Pop out the workspace into a compact, always-on-top floating window over your AI chat tab so you never have to switch tabs.
* **🛠️ Cut-Off JSON Recovery:** Automatically detects when an AI response is cut off halfway due to output token limits and provides a 1-click recovery prompt to request a compact or split JSON update.
* **🌍 Bilingual Interface:** Seamlessly switch between English (`EN`) and Dutch (`NL`).

### 4. How Does It Work? (3-Step Workflow)

#### Step 1 — Open & Link Project Folder
Click **Choose project folder** and select a local directory on your computer. The tool scans your files and subfolders and displays them in the file explorer on the left. Use the checkboxes to choose which files to include.

#### Step 2 — Write Prompt & Copy to Your Favorite AI
Type what you want to build, refactor, or fix in the prompt field and choose the appropriate action:
* **Starting a new chat?** Click **Full project + prompt** to copy your project context, system instructions, and prompt.
* **Continuing an ongoing chat?** Click **Sync + prompt** (to include files you edited locally since the last sync) or **Prompt only** (to send just your follow-up task).
* Paste (`Ctrl+V` / `Cmd+V`) into ChatGPT, Claude, Gemini, or any other AI assistant.

#### Step 3 — Read Clipboard & Auto-Update Project Folder
The AI will explain its changes and finish with a single `json` code block. Copy that code block in your AI chat and click **Read clipboard & update folder** in AI Folder Sync. All new folders, new files, code edits, moves, and deletions are applied directly to your local disk.

<details>
<summary><strong>📄 View example of the AI JSON update format</strong></summary>

```json
{
  "folders": ["css", "js"],
  "move": {
    "old.css": "css/style.css"
  },
  "files": {
    "js/new-file.js": "// Full code for a brand-new file..."
  },
  "edit": {
    "index.html": [
      {
        "search": "<h1>Old Title</h1>",
        "replace": "<h1>New Title</h1>"
      }
    ]
  },
  "delete": ["old.txt"]
}
```
</details>

### 5. Requirements & Privacy
* **🔒 100% Local & Private:** AI Folder Sync runs entirely client-side in your browser. **Zero bytes** of your source code or files are ever uploaded to an external server by this tool.
* **🌐 Supported Browsers:** Because the tool relies on the official W3C **File System Access API** (and **Document Picture-in-Picture API** for the floating window), please use a Chromium-based desktop browser:
  * **Google Chrome** (Desktop)
  * **Microsoft Edge** (Desktop)
  * **Brave** or **Opera** (Desktop)

---

<a id="nederlands"></a>

## 🇳🇱 Nederlands

### 1. Korte Introductie
**AI Folder Sync** slaat de brug tussen je lokale projectbestanden en elke webgebaseerde AI-assistent (zoals ChatGPT, Claude, Gemini of DeepSeek). Koppel lokaal je projectmap, kopieer je mappenstructuur, code en opdracht met één klik voor je favoriete AI, en schrijf de door de AI gegenereerde wijzigingen vanaf je klembord met één klik direct terug naar je eigen bestanden op je harde schijf.

### 2. Live Tool
👉 **Open de tool direct in je browser:**  
### [**https://ivannijdam08-web.github.io/ai-folder-sync/**](https://ivannijdam08-web.github.io/ai-folder-sync/)
*(Geen installatie, account of API-sleutel nodig.)*

### 3. Belangrijkste Functies
* **📂 Lokale Map- & Bestandsverkenner:** Koppel een bestaande projectmap — of een lege map voor een compleet nieuw project — en bekijk een overzichtelijke boomstructuur met bestandsgroottes, regelnummers en selectievakjes per bestand.
* **📋 Volledig Project Kopiëren (Nieuwe Chat):** Kopieer met één klik je volledige mappenstructuur, alle aangevinkte bestanden, je prompt én de AI-systeeminstructie naar het klembord (of download alles als `.txt`-bestand).
* **🔄 Live Auto-Sync & Delta-detectie (Lopende Chat):** Controleert je map op de achtergrond automatisch op wijzigingen die je zelf tussentijds maakt in bijvoorbeeld VS Code of Verkenner. Met **Sync + prompt** stuur je *alleen* de bestanden mee die je handmatig hebt aangepast, toegevoegd of verwijderd, zodat de AI zijn geheugen bijwerkt zonder dat je het hele project opnieuw hoeft te sturen.
* **💬 Alleen Prompt-tekst Kopiëren:** Kopieer razendsnel enkel je vervolgopdracht (inclusief compacte JSON-herinnering) wanneer je tussentijds zelf geen bestanden op schijf hebt gewijzigd.
* **⚡ 1-Klik Klembord Updater & Slimme Diffs:** Leest het JSON-codeblok van de AI rechtstreeks vanaf je klembord en voert nieuwe mappen (`folders`), nieuwe bestanden (`files`), verplaatsingen (`move`), verwijderingen (`delete`) én gerichte code-aanpassingen (`edit` met 3-laags witruimte-herkenning) direct uit op je harde schijf.
* **📌 Zwevend Picture-in-Picture Paneel:** Plaats het werkpaneel als een compact, zwevend venster altijd bovenop het tabblad van je AI-chat, zodat je nooit meer tussen tabbladen hoeft te wisselen.
* **🛠️ Herstel bij Afgekapte JSON (Token-limiet):** Herkent automatisch wanneer een JSON-antwoord van de AI halverwege is afgebroken door de maximale output-limiet en biedt met 1 klik een herstel-prompt voor een compacte of opgesplitste update.
* **🌍 Tweetalige Interface:** Schakel direct tussen Nederlands (`NL`) en Engels (`EN`).

### 4. Hoe Werkt Het? (Stappenplan in 3 stappen)

#### Stap 1 — Projectmap openen & koppelen
Klik op **Kies projectmap** en selecteer een map op je computer. De tool scant direct alle submappen en bestanden en toont deze overzichtelijk in de linkerkolom. Vink aan welke bestanden je wilt meesturen.

#### Stap 2 — Opdracht typen & kopiëren naar je favoriete AI
Typ in het tekstveld wat je wilt laten bouwen, uitbreiden of aanpassen en kies de gewenste kopieer-actie:
* **Start je een nieuwe chat?** Klik op **Hele project + prompt** om je mappenstructuur, geselecteerde bestanden, systeeminstructie en opdracht te kopiëren.
* **Werk je in een lopende chat?** Klik op **Sync + prompt** (om tussentijdse handmatige bestandswijzigingen + je prompt te sturen) of **Alleen prompt** (als je alleen een nieuwe vervolgopdracht wilt sturen).
* Plak (`Ctrl+V` / `Cmd+V`) het geheel in ChatGPT, Claude, Gemini of een andere AI-assistent.

#### Stap 3 — Klembord lezen & projectmap automatisch bijwerken
De AI legt kort uit wat er is aangepast en eindigt met één `json`-codeblok. Kopieer dit JSON-blok in je AI-chat en klik in de tool op **Lees klembord & update map**. Alle nieuwe mappen, bestanden, wijzigingen en verwijderingen worden direct op je harde schijf doorgevoerd.

<details>
<summary><strong>📄 Bekijk een voorbeeld van het JSON-updateformaat</strong></summary>

```json
{
  "folders": ["css", "js"],
  "move": {
    "oud.css": "css/style.css"
  },
  "files": {
    "js/nieuw.js": "// Volledige code voor een nieuw bestand..."
  },
  "edit": {
    "index.html": [
      {
        "search": "<h1>Oude Titel</h1>",
        "replace": "<h1>Nieuwe Titel</h1>"
      }
    ]
  },
  "delete": ["oud.txt"]
}
```
</details>

### 5. Technische Vereisten & Privacy
* **🔒 100% Lokaal & Privé:** AI Folder Sync draait volledig *client-side* in je eigen browser. Er worden via deze tool **0 bytes** van je broncode of bestanden naar een externe server geüpload.
* **🌐 Ondersteunde Browsers:** Omdat de tool gebruikmaakt van de officiële W3C **File System Access API** (en de **Document Picture-in-Picture API** voor het zwevende venster), werkt het koppelen en bewerken van lokale mappen in Chromium-browsers op desktop/laptop:
  * **Google Chrome** (Desktop)
  * **Microsoft Edge** (Desktop)
  * **Brave** of **Opera** (Desktop)

---

<div align="center">
  <sub>Built for fast, local, and private AI-assisted development — <a href="https://ivannijdam08-web.github.io/ai-folder-sync/">AI Folder Sync</a></sub>
</div>
