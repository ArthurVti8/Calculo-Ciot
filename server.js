// ======================================================
// SERVER — Calculadora de Frete Mínimo ANTT
// Com endpoints para Scraper, Monitor e Salvar Tabelas
// ======================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { scrapeResolucao } = require('./scraper');
const { verificarAtualizacao, getStatus } = require('./monitor');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { GoogleGenerativeAI } = require("@google/generative-ai");
const sql = require('mssql');
const { exec } = require('child_process');

// --- AUTO-SHUTDOWN HEARTBEAT ---
let lastHeartbeat = Date.now();
// Checa a cada 30 segundos se o frontend parou de pingar
setInterval(() => {
  // Timeout de 5 minutos (300.000 ms) para evitar que a aba em segundo plano do Chrome 
  // (que suspende os timers) faça o servidor desligar sozinho.
  if (Date.now() - lastHeartbeat > 300000) {
    console.log('[Sistema] Frontend fechado ou inativo por 5 minutos. Desligando o servidor...');
    process.exit(0);
  }
}, 30000);
// -------------------------------

// Chave da API (agora escondida no arquivo .env)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const PORT = 3001;
const TABELAS_FILE = path.join(process.cwd(), 'tabelas_frete.json');
const BACKUP_DIR = path.join(process.cwd(), 'backups');

// Leitura do UDL caso passado como argumento (Integração Delphi) ou Auto-Detecção
let argFile = process.argv[2];

if (!argFile) {
  // Se não passou argumento, tenta primeiro VTI.udl, senão procura qualquer outra na pasta
  const files = fs.readdirSync(process.cwd());
  const vtiUdl = files.find(f => f.toLowerCase() === 'vti.udl');
  
  if (vtiUdl) {
    argFile = vtiUdl;
    console.log(`[UDL] VTI.udl detectada na pasta. Selecionando como base principal...`);
  } else {
    const udlFiles = files.filter(f => f.toLowerCase().endsWith('.udl'));
    if (udlFiles.length > 0) {
      argFile = udlFiles[0];
      console.log(`[UDL] Várias UDLs encontradas. Auto-selecionando a primeira: ${argFile}`);
    }
  }
}

if (argFile && argFile.toLowerCase().endsWith('.udl')) {
  try {
    const udlPath = path.resolve(process.cwd(), argFile);
    if (fs.existsSync(udlPath)) {
      // UDL geralmente é UTF-16LE, lemos o buffer e removemos nulos
      const buffer = fs.readFileSync(udlPath);
      const content = buffer.toString('utf16le').replace(/\0/g, ''); 
      const creds = {};
      
      content.split(';').forEach(p => {
        const [k, v] = p.split('=');
        if (k && v) creds[k.trim().toLowerCase()] = v.trim();
      });

      if (creds['data source']) process.env.DB_SERVER = creds['data source'];
      if (creds['initial catalog']) process.env.DB_NAME = creds['initial catalog'];
      if (creds['user id']) process.env.DB_USER = creds['user id'];
      if (creds['password']) process.env.DB_PASSWORD = creds['password'];
      
      console.log(`[UDL] Banco de dados configurado via ${path.basename(argFile)}`);
      console.log(`[UDL] Conectando em: ${process.env.DB_SERVER} -> ${process.env.DB_NAME}`);
    } else {
      console.error(`[ERRO UDL] Arquivo não encontrado: ${udlPath}`);
    }
  } catch (err) {
    console.error(`[ERRO UDL] Falha ao ler arquivo:`, err.message);
  }
}


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
  if (url.pathname === '/api/heartbeat' && req.method === 'GET') {
    lastHeartbeat = Date.now();
    res.writeHead(200);
    res.end('ok');
    return;
  }

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
      sendJSON(res, 500, { erro: 'Servidor com instabilidades, favor tentar novamente mais tarde! (Ou, se preferir, atualize manualmente).' });
    }
    return;
  }

  // POST /api/sync-sqlserver — Integração ERP Delphi SQL Server
  if (url.pathname === '/api/sync-sqlserver' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const tabelasAntt = JSON.parse(body);
      const eixosArr = tabelasAntt.eixos;
      
      const config = {
        user: process.env.DB_USER || 'sa',
        password: process.env.DB_PASSWORD || '',
        server: process.env.DB_SERVER || 'localhost',
        database: process.env.DB_NAME || 'TripaGel0001',
        options: { encrypt: false, trustServerCertificate: true }
      };

      const pool = new sql.ConnectionPool(config);
      await pool.connect();
      const request = pool.request();

      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='FA_CIOT_TABELA_CADASTRO' and xtype='U')
        CREATE TABLE [dbo].[FA_CIOT_TABELA_CADASTRO] (
            [ID_TABELA] [int] IDENTITY(1,1) NOT NULL,
            [DESCRICAO] [varchar](100) NULL,
            [TIPO_TABELA] [char](1) NOT NULL,
            [NR_RESOLUCAO] [varchar](20) NULL,
            [DATA_PUBLICACAO] [datetime] NULL,
            [INICIO_VIGENCIA] [datetime] NULL,
            [FIM_VIGENCIA] [datetime] NULL,
            CONSTRAINT [PK_FA_CIOT_TABELA_CADASTRO] PRIMARY KEY CLUSTERED ([ID_TABELA] ASC)
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='FA_CIOT_TABELA_VALORES' and xtype='U')
        CREATE TABLE [dbo].[FA_CIOT_TABELA_VALORES] (
            [ID_VALOR] [int] IDENTITY(1,1) NOT NULL,
            [ID_TABELA] [int] NOT NULL,
            [ID_TIPO_CARGA] [varchar](2) NOT NULL,
            [NR_EIXOS] [int] NOT NULL,
            [CCD_VALOR] [decimal](10,4) NOT NULL,
            [CC_VALOR] [decimal](10,4) NOT NULL,
            CONSTRAINT [PK_FA_CIOT_TABELA_VALORES] PRIMARY KEY CLUSTERED ([ID_VALOR] ASC),
            CONSTRAINT [UQ_TABELA_CARGA_EIXOS] UNIQUE ([ID_TABELA], [ID_TIPO_CARGA], [NR_EIXOS]),
            CONSTRAINT [FK_TABELA_VALORES_CADASTRO] FOREIGN KEY ([ID_TABELA]) 
                REFERENCES [dbo].[FA_CIOT_TABELA_CADASTRO] ([ID_TABELA]) ON DELETE CASCADE
        );
      `);

      const tblKeys = ['A', 'B', 'C', 'D'];
      const meta = tabelasAntt.metadata || {};
      const resolucaoAtual = meta.resolucao || "6.084/2026"; 
      const dataPublicacaoStr = meta.dataPublicacao || "2026-07-17"; 
      const inicioVigenciaStr = meta.inicioVigencia || "2026-07-16"; 
      let totalInseridos = 0;

      for (const tk of tblKeys) {
         // Lógica Limpa: Apenas UMA tabela de cada tipo (A, B, C, D) no banco.
         const upsertResult = await request.query(`
             DECLARE @NewInicioVigencia DATETIME = '${inicioVigenciaStr}';
             DECLARE @NewDataPublicacao DATETIME = '${dataPublicacaoStr}';
             DECLARE @IdTabela INT;

             -- Tenta encontrar se a tabela (A, B, C ou D) já existe
             SELECT @IdTabela = ID_TABELA 
             FROM [dbo].[FA_CIOT_TABELA_CADASTRO] 
             WHERE TIPO_TABELA = '${tk}';

             IF @IdTabela IS NOT NULL
             BEGIN
                 -- ATUALIZAR TABELA EXISTENTE (sobrescreve os dados da resolução anterior)
                 UPDATE [dbo].[FA_CIOT_TABELA_CADASTRO]
                 SET DESCRICAO = 'Tabela ANTT ${tk} - Resolucao ${resolucaoAtual}',
                     NR_RESOLUCAO = '${resolucaoAtual}',
                     DATA_PUBLICACAO = @NewDataPublicacao,
                     INICIO_VIGENCIA = @NewInicioVigencia,
                     FIM_VIGENCIA = NULL 
                 WHERE ID_TABELA = @IdTabela;

                 -- Apagar os coeficientes antigos para re-inserir os atualizados
                 DELETE FROM [dbo].[FA_CIOT_TABELA_VALORES] WHERE ID_TABELA = @IdTabela;
             END
             ELSE
             BEGIN
                 -- INSERIR A PRIMEIRA VEZ
                 INSERT INTO [dbo].[FA_CIOT_TABELA_CADASTRO] 
                 (DESCRICAO, TIPO_TABELA, NR_RESOLUCAO, DATA_PUBLICACAO, INICIO_VIGENCIA, FIM_VIGENCIA)
                 VALUES 
                 ('Tabela ANTT ${tk} - Resolucao ${resolucaoAtual}', '${tk}', '${resolucaoAtual}', @NewDataPublicacao, @NewInicioVigencia, NULL);

                 SET @IdTabela = SCOPE_IDENTITY();
             END

             -- Retorna o ID
             SELECT @IdTabela AS ID_TABELA;
         `);
         
         const idTabela = upsertResult.recordset[0].ID_TABELA;
         
         // 2. Prepara Valores
         const tData = tabelasAntt.tabelas[tk].dados;
         let values = [];
         
         for (const codCarga in tData) {
            const cargaId = codCarga.toString();
            for (let i=0; i<eixosArr.length; i++) {
               const numEixos = eixosArr[i];
               const valKm = tData[codCarga].CCD[i] !== null ? tData[codCarga].CCD[i] : 0;
               const valFixo = tData[codCarga].CC[i] !== null ? tData[codCarga].CC[i] : 0;
               
               if (valKm > 0 || valFixo > 0) {
                 values.push(`(${idTabela}, '${cargaId}', ${numEixos}, ${valKm}, ${valFixo})`);
               }
            }
         }
         
         // 3. Inserir Valores
         const chunkSize = 100;
         for (let i = 0; i < values.length; i += chunkSize) {
             const chunk = values.slice(i, i + chunkSize);
             await request.query(`INSERT INTO [dbo].[FA_CIOT_TABELA_VALORES] (ID_TABELA, ID_TIPO_CARGA, NR_EIXOS, CCD_VALOR, CC_VALOR) VALUES ${chunk.join(',')}`);
         }
         totalInseridos += values.length;
      }
      await pool.close();
      sendJSON(res, 200, { sucesso: true, message: `${totalInseridos} coeficientes atualizados com sucesso!` });
    } catch(e) {
      console.error('[API] Erro SQL Server:', e);
      sendJSON(res, 500, { erro: e.message });
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
      sendJSON(res, 500, { erro: 'Servidor com instabilidades, favor tentar novamente mais tarde! (Ou, se preferir, atualize manualmente).' });
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
      sendJSON(res, 500, { erro: 'Servidor com instabilidades, favor tentar novamente mais tarde! (Ou, se preferir, atualize manualmente).' });
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
      const tmpFile = path.join(process.cwd(), '_ocr_temp.png');
      fs.writeFileSync(tmpFile, imgBuffer);

      console.log(`[OCR] Imagem salva. Iniciando Gemini Vision AI...`);

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

      // Sistema de Fallback Profissional para os modelos da IA
      const modelNamesToTry = [
        "gemini-flash-latest",
        "gemini-1.5-flash",
        "gemini-1.0-pro-vision-latest"
      ];

      let text = null;
      let lastError = null;
      let success = false;

      for (const modelName of modelNamesToTry) {
        let attempts = 0;
        const maxAttempts = 3; // Tentar até 3 vezes por modelo
        
        while (attempts < maxAttempts && !success) {
          try {
            console.log(`[OCR] Tentando modelo: ${modelName} (Tentativa ${attempts + 1}/${maxAttempts})...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent([prompt, ...imageParts]);
            const response = await result.response;
            text = response.text();
            console.log(`[OCR] Sucesso com o modelo ${modelName}!`);
            success = true;
            break; 
          } catch (err) {
            console.warn(`[OCR] Falha no ${modelName}: ${err.message}`);
            lastError = err;
            attempts++;
            
            if (!success && attempts < maxAttempts && (err.message.includes("503") || err.message.includes("429"))) {
              // Exponential Backoff: 2s, 4s, 8s...
              const delay = Math.pow(2, attempts) * 1000; 
              console.log(`[OCR] Servidor lotado. Exponential Backoff ativado: aguardando ${delay/1000} segundos...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            } else if (!err.message.includes("503") && !err.message.includes("429")) {
              break; // Erro 404 ou estrutural, pula para o próximo modelo
            }
          }
        }
        if (success) break;
      }

      if (!text) {
        throw new Error(`Todos os modelos falharam. Último erro: ${lastError.message}`);
      }

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
      let erroAmigavel = 'Servidor com instabilidades, favor tentar novamente mais tarde! (Ou, se preferir, atualize manualmente).';
      if (e.message.includes('API key not valid') || e.message.includes('API_KEY_INVALID')) {
        erroAmigavel = 'Falha de comunicação: Chave de API inválida ou ausente. Por favor, feche o sistema e tente novamente mais tarde, ou atualize manualmente!';
      }
      sendJSON(res, 500, { erro: erroAmigavel });
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

const args = process.argv.slice(2);
const openBrowser = !args.includes('--no-browser');

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
  console.log(`  ╚════════════════════════════════════════════════╝\n`);
  
  if (openBrowser) {
    console.log(`[Sistema] Tentando abrir em Modo Aplicativo Nativo...`);
    
    // Lista dos caminhos mais comuns do Chrome e Edge
    const progFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const progFiles86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'];

    const browserPaths = [
      `${progFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${progFiles86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      `${progFiles86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${progFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
    ];

    let launchedAppMode = false;

    for (let bPath of browserPaths) {
      if (fs.existsSync(bPath)) {
        console.log(`[Sistema] Navegador compativel encontrado: ${bPath}`);
        // Abre especificando o caminho completo e o parâmetro --app
        exec(`"${bPath}" --app=http://localhost:${PORT}`);
        launchedAppMode = true;
        break;
      }
    }

    if (!launchedAppMode) {
      console.log(`[Sistema] Chrome/Edge nao encontrados. Abrindo no navegador padrao...`);
      exec(`start http://localhost:${PORT}`);
    }
  } else {
    console.log(`[Sistema] Modo silencioso ativado (--no-browser). Aguardando conexão...`);
  }
  
  // Inicia o monitoramento
  verificarAtualizacao();
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (openBrowser) {
      console.log('[Sistema] O servidor já está rodando em segundo plano. Tentando abrir interface...');
      
      const progFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const progFiles86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'];

      const browserPaths = [
        `${progFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${progFiles86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
        `${progFiles86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${progFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
      ];

      let launched = false;
      for (let bPath of browserPaths) {
        if (fs.existsSync(bPath)) {
          exec(`"${bPath}" --app=http://localhost:${PORT}`);
          launched = true;
          break;
        }
      }

      if (!launched) {
        exec(`start http://localhost:${PORT}`);
      }
    }
    setTimeout(() => process.exit(0), 1000);
  } else {

    console.error(e);
  }
});
