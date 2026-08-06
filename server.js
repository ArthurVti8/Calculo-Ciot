// ======================================================
// SERVER — Calculadora de Frete Mínimo ANTT
// Com endpoints para Scraper, Monitor e Salvar Tabelas
// ======================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { scrapeResolucao } = require('./scraper');
const { verificarAtualizacao, getStatus } = require('./monitor');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Chave da API (agora escondida no arquivo .env)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const PORT = 3001;
const TABELAS_FILE = path.join(__dirname, 'tabelas_frete.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

/**
 * Lê o body de uma requisição POST
 */
function readBody(req, maxSize = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Body excede o limite de ' + Math.round(maxSize / 1024 / 1024) + 'MB'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Envia resposta JSON
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

/**
 * Cria backup do JSON atual antes de sobrescrever
 */
function criarBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  if (fs.existsSync(TABELAS_FILE)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `tabelas_frete_${timestamp}.json`);
    fs.copyFileSync(TABELAS_FILE, backupFile);
    console.log(`[Backup] Criado: ${backupFile}`);
    return backupFile;
  }
  return null;
}

// ===== HTTP SERVER =====
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ===== API ROUTES =====

  // POST /api/salvar-tabelas — Salva tabelas atualizadas
  if (url.pathname === '/api/salvar-tabelas' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const novasTabelas = JSON.parse(body);

      // Validar estrutura básica
      if (!novasTabelas.tabelas || !novasTabelas.tabelas.A || !novasTabelas.tabelas.B ||
          !novasTabelas.tabelas.C || !novasTabelas.tabelas.D) {
        return sendJSON(res, 400, { erro: 'Estrutura JSON inválida. São necessárias 4 tabelas (A, B, C, D).' });
      }

      // Criar backup
      const backupFile = criarBackup();

      // Salvar novo JSON
      fs.writeFileSync(TABELAS_FILE, JSON.stringify(novasTabelas, null, 2), 'utf8');
      console.log('[API] Tabelas atualizadas com sucesso.');

      sendJSON(res, 200, {
        sucesso: true,
        mensagem: 'Tabelas atualizadas com sucesso!',
        backup: backupFile ? path.basename(backupFile) : null
      });
    } catch (e) {
      console.error('[API] Erro ao salvar tabelas:', e.message);
      sendJSON(res, 500, { erro: 'Erro ao salvar tabelas: ' + e.message });
    }
    return;
  }

  // GET /api/verificar-atualizacao — Monitor: verifica se há nova resolução
  if (url.pathname === '/api/verificar-atualizacao' && req.method === 'GET') {
    try {
      console.log('[Monitor] Verificando atualizações no DOU...');
      const resultado = await verificarAtualizacao();
      sendJSON(res, 200, resultado);
    } catch (e) {
      console.error('[Monitor] Erro:', e.message);
      sendJSON(res, 500, { erro: 'Erro ao verificar atualizações: ' + e.message });
    }
    return;
  }

  // GET /api/monitor-status — Monitor: retorna estado atual sem nova busca
  if (url.pathname === '/api/monitor-status' && req.method === 'GET') {
    try {
      const status = getStatus();
      sendJSON(res, 200, status);
    } catch (e) {
      sendJSON(res, 500, { erro: e.message });
    }
    return;
  }

  // POST /api/scraper — Scraper: extrai tabelas de uma URL do DOU
  if (url.pathname === '/api/scraper' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { url: targetUrl } = JSON.parse(body);

      if (!targetUrl || !targetUrl.includes('in.gov.br')) {
        return sendJSON(res, 400, { erro: 'URL inválida. Informe uma URL do DOU (in.gov.br).' });
      }

      console.log(`[Scraper] Extraindo tabelas de: ${targetUrl}`);
      const tabelas = await scrapeResolucao(targetUrl);

      console.log(`[Scraper] ${Object.keys(tabelas).length} tabelas extraídas com sucesso.`);
      sendJSON(res, 200, { sucesso: true, tabelas });
    } catch (e) {
      console.error('[Scraper] Erro:', e.message);
      sendJSON(res, 500, { erro: 'Erro ao extrair tabelas: ' + e.message });
    }
    return;
  }

  // POST /api/ocr — Processa imagem/PDF com Tesseract OCR no servidor
  if (url.pathname === '/api/ocr' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { image, tableId } = JSON.parse(body);

      if (!image) {
        return sendJSON(res, 400, { erro: 'Nenhuma imagem fornecida.' });
      }

      console.log(`[OCR] Processando imagem para Tabela ${tableId || '?'}...`);

      // Decodificar base64
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '').replace(/^data:application\/pdf;base64,/, '');
      const imgBuffer = Buffer.from(base64Data, 'base64');

      // Salvar temporariamente
      const tmpFile = path.join(__dirname, '_ocr_temp.png');
      fs.writeFileSync(tmpFile, imgBuffer);

      console.log(`[OCR] Imagem salva. Iniciando Gemini Vision AI...`);

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

      const prompt = `
Você é um extrator de dados de tabelas de frete da ANTT.
A imagem anexa é a "Tabela ${tableId}" da Resolução ANTT de frete mínimo.
Sua tarefa é ler todos os coeficientes da tabela e me retornar um JSON puro.

A tabela possui até 12 tipos de carga (linhas 1 a 12).
Para cada carga, existem 7 colunas de eixos: [2, 3, 4, 5, 6, 7, 9].
Para cada carga, existem duas linhas de valores: "Deslocamento (CCD)" e "Carga e descarga (CC)".

Importante: Se a tabela tiver células vazias para determinados eixos (ex: tabelas B e D geralmente não têm valores para 2 e 3 eixos), você deve usar \`null\`.
Os valores CC geralmente são altos (ex: 200.00, 500.00) e os valores CCD são baixos (ex: 4.5000, 6.7000).

O formato exato de saída deve ser um JSON válido sem marcação markdown:
{
  "1": {
    "CCD": [num, num, num, num, num, num, num],
    "CC": [num, num, num, num, num, num, num]
  },
  "2": { ... }
}
Substitua 'num' pelos valores numéricos (use ponto para decimais, ex: 4.5000).
Não adicione mais nenhum texto na sua resposta além do JSON.
`;

      const imageParts = [
        {
          inlineData: {
            data: base64Data,
            mimeType: "image/png"
          }
        },
      ];

      const result = await model.generateContent([prompt, ...imageParts]);
      const response = await result.response;
      let text = response.text();

      // Limpar arquivo temporario
      try { fs.unlinkSync(tmpFile); } catch(e) {}

      console.log(`[OCR] Gemini respondeu. Analisando JSON...`);
      console.log('--- GEMINI RAW TEXT ---');
      console.log(text);
      console.log('-----------------------');

      // Remover blocos markdown se existirem
      if (text.startsWith('\`\`\`')) {
        text = text.replace(/^\`\`\`(json)?/, '').replace(/\`\`\`$/, '').trim();
      }

      const dados = JSON.parse(text);
      const count = Object.keys(dados).length;

      console.log(`[OCR] ${count} tipos de carga encontrados.`);

      sendJSON(res, 200, {
        sucesso: true,
        dados,
        textoRaw: text,
        cargasEncontradas: count
      });
    } catch (e) {
      console.error('[OCR] Erro:', e.message);
      sendJSON(res, 500, { erro: 'Erro no OCR: ' + e.message });
    }
    return;
  }


  // GET /api/backups — Lista backups disponíveis
  if (url.pathname === '/api/backups' && req.method === 'GET') {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return sendJSON(res, 200, { backups: [] });
      }
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
      sendJSON(res, 200, { backups: files });
    } catch (e) {
      sendJSON(res, 500, { erro: e.message });
    }
    return;
  }

  // POST /api/restaurar-backup — Restaura um backup
  if (url.pathname === '/api/restaurar-backup' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { arquivo } = JSON.parse(body);

      const backupPath = path.join(BACKUP_DIR, arquivo);
      if (!fs.existsSync(backupPath)) {
        return sendJSON(res, 404, { erro: 'Backup não encontrado.' });
      }

      // Create backup of current before restoring
      criarBackup();

      fs.copyFileSync(backupPath, TABELAS_FILE);
      console.log(`[API] Backup restaurado: ${arquivo}`);
      sendJSON(res, 200, { sucesso: true, mensagem: 'Backup restaurado com sucesso!' });
    } catch (e) {
      sendJSON(res, 500, { erro: e.message });
    }
    return;
  }

  // ===== STATIC FILES =====
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ===== PARSER INTELIGENTE PARA OCR =====
function parseOcrTable(text) {
  const dados = {};
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const eixosCount = 7; // [2, 3, 4, 5, 6, 7, 9]

  let currentId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Buscar ID de carga (1 a 12) no inicio da linha (com ou sem espaco, as vezes com sujeira)
    const matchId = line.match(/^(\d{1,2})[\s\|]*[a-zA-Z]/);
    if (matchId) {
      const id = parseInt(matchId[1]);
      if (id >= 1 && id <= 12) {
        currentId = id;
        if (!dados[id]) dados[id] = { CCD: [], CC: [] };

        // Extrair numeros dessa linha (ignorando o primeiro numero que eh o ID)
        const lineWithoutId = line.substring(matchId[0].length - 1);
        const nums = extractNums(lineWithoutId);
        if (nums.length > 0) {
          // Decidir se sao CCD (valores pequenos ~3-10) ou CC (valores grandes ~100-1000)
          if (nums.some(n => n > 50)) {
            dados[id].CC = padArr(nums, eixosCount);
          } else {
            dados[id].CCD = padArr(nums, eixosCount);
          }
        }
        continue;
      }
    }

    // Linha sem ID — pode ser a segunda linha do cargo atual (CC ou CCD)
    if (currentId && dados[currentId]) {
      const nums = extractNums(line);
      if (nums.length >= 3) {
        if (nums.some(n => n > 50) && dados[currentId].CC.length === 0) {
          dados[currentId].CC = padArr(nums, eixosCount);
          currentId = null;
        } else if (nums.some(n => n < 50) && dados[currentId].CCD.length === 0) {
          dados[currentId].CCD = padArr(nums, eixosCount);
        }
      }
    }
  }

  // Garantir que todas as arrays estejam preenchidas
  for (const id in dados) {
    dados[id].CCD = padArr(dados[id].CCD, eixosCount);
    dados[id].CC = padArr(dados[id].CC, eixosCount);
  }

  return dados;
}

function extractNums(str) {
  const nums = [];
  // Encontrar todos os numeros decimais no texto
  const matches = str.match(/\d[\d.,]*\d|\d/g) || [];
  for (const m of matches) {
    // Normalizar: trocar virgula por ponto
    let clean = m.replace(/,/g, '.');
    // Se tiver mais de um ponto, manter so o ultimo (ex: 1.234.56 -> 1234.56)
    const parts = clean.split('.');
    if (parts.length > 2) {
      clean = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    }
    const n = parseFloat(clean);
    if (!isNaN(n) && n > 0.1) {
      nums.push(n);
    }
  }
  return nums;
}

function padArr(arr, length) {
  if (!arr) arr = [];
  while (arr.length < length) arr.push(null);
  return arr.slice(0, length);
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════════╗');
  console.log('  ║  Calculadora de Frete Mínimo ANTT             ║');
  console.log('  ║  Resolução 6.084/2026                         ║');
  console.log('  ╠════════════════════════════════════════════════╣');
  console.log(`  ║  http://localhost:${PORT}                        ║`);
  console.log('  ╠════════════════════════════════════════════════╣');
  console.log('  ║  API Endpoints:                                ║');
  console.log('  ║  POST /api/salvar-tabelas                      ║');
  console.log('  ║  GET  /api/verificar-atualizacao               ║');
  console.log('  ║  POST /api/scraper                             ║');
  console.log('  ║  GET  /api/backups                             ║');
  console.log('  ╚════════════════════════════════════════════════╝');
  console.log('');
});
