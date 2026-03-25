
const { Plugin, Notice, MarkdownRenderer, normalizePath } = require('obsidian');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { pathToFileURL } = require('url');

/**
 * Convert a local filesystem path to a file:// URL safely.
 * Works on Windows and POSIX. Falls back to manual encoding if needed.
 */
function toFileUrl(p) {
  try {
    // Ensure we hand pathToFileURL a native path (backslashes on Win)
    const native = process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
    return pathToFileURL(native).href;
  } catch (e) {
    // Fallback: manual build
    const normalized = p.replace(/\\/g, '/');
    return 'file:///' + encodeURI(normalized);
  }
}

/**
 * Replace Obsidian's internal app:// image URLs with file:// URLs
 * so that images load in exported standalone HTML.
 * Also resolves vault-relative image paths to absolute file:// URLs.
 */
function rewriteImageSrcsIn(container, vaultBasePath) {
  const imgs = container.querySelectorAll('img');
  imgs.forEach((img) => {
    const original = img.getAttribute('src') || '';

    // Skip if already a web/file URL
    if (/^[a-z]+:\/\//i.test(original)) {
      if (original.startsWith('app://')) {
        // app://<hash>/ABSOLUTE_PATH[?cachebust]
        let rest = original.replace(/^app:\/\/[^/]+\/+/, '');
        rest = rest.split('?')[0]; // strip query/cachebust

        // If it's still not absolute, resolve against vault
        let finalFsPath;
        if (/^[A-Za-z]:[\\/]/.test(rest) || rest.startsWith('/')) {
          finalFsPath = rest;
        } else {
          finalFsPath = path.join(vaultBasePath, rest);
        }

        img.setAttribute('src', toFileUrl(finalFsPath));
      }
      return;
    }

    // Relative path -> resolve against vault root
    const absoluteFsPath = path.join(vaultBasePath, original);
    img.setAttribute('src', toFileUrl(absoluteFsPath));
  });

  // Optional: fix <source srcset> in case of markdown image with srcset
  const sources = container.querySelectorAll('source[srcset]');
  sources.forEach((srcEl) => {
    const original = srcEl.getAttribute('srcset') || '';
    if (!original) return;

    // Handle comma-separated srcset entries
    const entries = original.split(',').map((e) => e.trim()).filter(Boolean);
    const rewritten = entries
      .map((entry) => {
        // Each entry can be "url [descriptor]"
        const parts = entry.split(/\s+/);
        const urlPart = parts.shift() || '';
        let url = urlPart;

        if (url.startsWith('app://')) {
          let rest = url.replace(/^app:\/\/[^/]+\/+/, '');
          rest = rest.split('?')[0];
          if (!(/^[A-Za-z]:[\\/]/.test(rest) || rest.startsWith('/'))) {
            rest = path.join(vaultBasePath, rest);
          }
          url = toFileUrl(rest);
        } else if (!/^[a-z]+:\/\//i.test(url)) {
          const abs = path.join(vaultBasePath, url);
          url = toFileUrl(abs);
        }
        return [url, ...parts].join(' ');
      })
      .join(', ');

    if (rewritten !== original) {
      srcEl.setAttribute('srcset', rewritten);
    }
  });
}

module.exports = class PrintSelectionPlugin extends Plugin {
  async onload() {
    new Notice('Print Selection Plugin geladen');

    this.addCommand({
      id: 'print-selection',
      name: 'Auswahl als HTML exportieren & im Browser öffnen',
      editorCallback: async (editor) => {
        await this.handleExport(editor);
      },
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        menu.addItem((item) =>
          item
            .setTitle('Auswahl drucken (im Browser)')
            .setIcon('printer')
            .onClick(async () => {
              await this.handleExport(editor);
            })
        );
      })
    );
  }

  async handleExport(editor) {
    const selectedText = editor.getSelection();
    if (!selectedText) {
      new Notice('Bitte markiere zuerst einen Textbereich.');
      return;
    }

    const container = document.createElement('div');
    await MarkdownRenderer.render(this.app, selectedText, container, '', this);

    // 🔧 Wichtig: Bild-URLs von app:// → file:// umschreiben
    const vaultBasePath = this.app.vault.adapter.basePath;
    rewriteImageSrcsIn(container, vaultBasePath);

    const html = container.innerHTML;

    // Basisstruktur
    const fullHtml = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Druckansicht</title>
  <style>
    
    body { font-family: sans-serif; margin: 2rem; }
    pre { background: #f0f0f0; padding: 1em; overflow-x: auto; }
    code { background: #eee; padding: 0.2em 0.4em; }
    h1, h2, h3 { margin-top: 1.5em; }
    blockquote { border-left: 4px solid #ccc; padding-left: 1em; color: #666; }
    img { max-width: 100%; height: auto; }
    /* Sichtbare Linie am Bildschirm beibehalten */
    hr { border: 0; border-top: 1px solid #ccc; margin: 2rem 0; }
    /* Beim Drucken nach jedem hr einen Seitenumbruch erzwingen */
    @media print {
      hr {
        break-after: page;          /* modern */
        page-break-after: always;   /* legacy */
        border: 0;                  /* Linie im Druck ausblenden */
        height: 0;
      }
    }

  </style>
</head>
<body>${html}</body>
</html>`;

    // Speicherort im Vault vorbereiten
    const exportFolder = '.print-output';
    const fileName = `druck-${Date.now()}.htm`;
    const filePath = normalizePath(path.join(this.app.vault.adapter.basePath, exportFolder, fileName));

    // Ordner ggf. erstellen
    const outputDir = path.dirname(filePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // HTML-Datei schreiben
    fs.writeFileSync(filePath, fullHtml, 'utf8');
    new Notice('HTML-Datei erstellt – wird im Browser geöffnet.');

    // Im Browser öffnen
    shell.openPath(filePath);
  }

  onunload() {}
};
