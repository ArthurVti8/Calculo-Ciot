// ======================================================
// SCRAPER — Extrator de Tabelas do DOU (Diário Oficial)
// ======================================================

const https = require('https');
const http = require('http');

/**
 * Faz fetch de uma URL com User-Agent de navegador real
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
      }
    };

    const req = client.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Timeout ao acessar o DOU'));
    });
  });
}

/**
 * Extrai texto de um elemento HTML (remove tags)
 */
function stripHTML(html) {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Parseia uma tabela HTML e extrai os dados
 */
function parseHTMLTable(tableHTML) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tableHTML)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripHTML(cellMatch[1]).replace(/\s+/g, ' '));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

/**
 * Encontra todas as tabelas no HTML
 */
function findTables(html) {
  const tables = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let match;

  while ((match = tableRegex.exec(html)) !== null) {
    tables.push(match[0]);
  }

  return tables;
}

/**
 * Identifica qual tabela ANTT é (A, B, C ou D) pelo conteúdo ao redor
 */
function identifyTable(html, tableIndex, allTables) {
  // Look for table identifiers in the surrounding text
  const beforeTable = html.substring(
    Math.max(0, html.indexOf(allTables[tableIndex]) - 500),
    html.indexOf(allTables[tableIndex])
  ).toUpperCase();

  if (beforeTable.includes('TABELA D') || (beforeTable.includes('ALTO DESEMPENHO') && beforeTable.includes('APENAS DO VE')))
    return 'D';
  if (beforeTable.includes('TABELA C') || (beforeTable.includes('ALTO DESEMPENHO') && beforeTable.includes('LOTA')))
    return 'C';
  if (beforeTable.includes('TABELA B') || (beforeTable.includes('APENAS DO VE') && !beforeTable.includes('ALTO')))
    return 'B';
  if (beforeTable.includes('TABELA A') || (beforeTable.includes('LOTA') && !beforeTable.includes('ALTO')))
    return 'A';

  // Fallback by index
  const keys = ['A', 'B', 'C', 'D'];
  return keys[tableIndex] || null;
}

/**
 * Converte texto numérico brasileiro para número
 */
function parseNum(text) {
  if (!text || text === '' || text === '—' || text === '-' || text.toLowerCase() === 'null') return null;
  let clean = text.replace(/\s/g, '').replace(/,/g, '.');
  const parts = clean.split('.');
  if (parts.length > 2) {
    clean = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  }
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}

const TIPOS_CARGA_NOMES = [
  { id: 1,  keywords: ['granel', 'sólido', 'solido'] },
  { id: 2,  keywords: ['granel', 'líquido', 'liquido'] },
  { id: 3,  keywords: ['frigorificada', 'aquecida'] },
  { id: 4,  keywords: ['conteinerizada'] },
  { id: 5,  keywords: ['carga geral'] },
  { id: 6,  keywords: ['neogranel'] },
  { id: 7,  keywords: ['perigosa', 'granel', 'sólido', 'solido'] },
  { id: 8,  keywords: ['perigosa', 'granel', 'líquido', 'liquido'] },
  { id: 9,  keywords: ['perigosa', 'frigorificada', 'aquecida'] },
  { id: 10, keywords: ['perigosa', 'conteinerizada'] },
  { id: 11, keywords: ['perigosa', 'carga geral'] },
  { id: 12, keywords: ['granel', 'pressurizada'] }
];

/**
 * Extrai os dados de uma tabela ANTT parseada
 */
function extractTableData(rows) {
  const eixosMap = [2, 3, 4, 5, 6, 7, 9];
  const dados = {};
  
  let axleCols = {};
  for (let r = 0; r < Math.min(rows.length, 8); r++) {
    let foundHeader = false;
    for (let c = 0; c < rows[r].length; c++) {
      const val = rows[r][c]?.trim();
      if (val === '2' || val === '3' || val === '4' || val === '5' || val === '6' || val === '7' || val === '9') {
        axleCols[parseInt(val)] = c;
        foundHeader = true;
      }
    }
    if (foundHeader) break;
  }

  // Se nao achou os eixos no cabecalho, tentar deduções heurísticas
  if (Object.keys(axleCols).length === 0) {
    axleCols = { 2: 4, 3: 5, 4: 6, 5: 7, 6: 8, 7: 9, 9: 10 };
  }

  let currentCargoId = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 4) continue;

    let cargoIdStr = row[0]?.trim();
    if (!cargoIdStr) cargoIdStr = row[1]?.trim(); // fallback for some weird nesting
    const cargoId = parseInt(cargoIdStr);

    if (!isNaN(cargoId) && cargoId >= 1 && cargoId <= 12) {
      currentCargoId = cargoId;
      if (!dados[cargoId]) {
        dados[cargoId] = { CCD: [], CC: [] };
      }

      const values = [];
      for (const e of eixosMap) {
        const colIdx = axleCols[e];
        if (colIdx !== undefined && colIdx < row.length) {
          values.push(parseNum(row[colIdx]));
        } else {
          values.push(null);
        }
      }
      dados[cargoId].CCD = values;
    } else if (currentCargoId) {
      const tipoStr = row.join(' ').toLowerCase();
      // Only process as CC if we haven't already and the row looks like a CC row
      if ((tipoStr.includes('carga') || tipoStr.includes('descarga') || tipoStr.includes('cc') || tipoStr.includes('r$')) && !tipoStr.includes('km')) {
        const values = [];
        for (const e of eixosMap) {
          const colIdx = axleCols[e];
          if (colIdx !== undefined && colIdx < row.length) {
            values.push(parseNum(row[colIdx]));
          } else {
            values.push(null);
          }
        }
        dados[currentCargoId].CC = values;
        currentCargoId = null; // Reset after finding CC for the current cargo
      }
    }
  }

  // Garante completude
  for (let id = 1; id <= 12; id++) {
    if (dados[id]) {
      while (dados[id].CCD.length < 7) dados[id].CCD.push(null);
      while (dados[id].CC.length < 7) dados[id].CC.push(null);
    }
  }

  return dados;
}

/**
 * Scrape completo: busca URL e extrai as 4 tabelas
 */
async function scrapeResolucao(url) {
  const html = await fetchPage(url);

  const tables = findTables(html);
  if (tables.length < 4) {
    throw new Error(`Encontradas apenas ${tables.length} tabelas na página (esperadas 4).`);
  }

  const result = {};
  const descriptions = {
    'A': 'Transporte Rodoviário de Carga Lotação',
    'B': 'Operações com contratação apenas do veículo automotor de cargas',
    'C': 'Transporte Rodoviário de Carga Lotação de Alto Desempenho',
    'D': 'Operações com contratação apenas do veículo automotor de cargas de Alto Desempenho'
  };

  const conditions = {
    'A': 'Lotação SEM Alto Desempenho',
    'B': 'Veículo Automotor SEM Alto Desempenho',
    'C': 'Lotação COM Alto Desempenho',
    'D': 'Veículo Automotor COM Alto Desempenho'
  };

  // Take the first 4 data tables (skip any non-data tables)
  let dataTableIdx = 0;
  const keys = ['A', 'B', 'C', 'D'];

  for (let i = 0; i < tables.length && dataTableIdx < 4; i++) {
    const rows = parseHTMLTable(tables[i]);

    // Skip tables with fewer than 5 rows (not a data table)
    if (rows.length < 5) continue;

    const key = identifyTable(html, i, tables) || keys[dataTableIdx];
    const dados = extractTableData(rows);

    // Only accept if we extracted at least 5 cargo types
    if (Object.keys(dados).length >= 5) {
      result[key] = {
        descricao: descriptions[key],
        condicao: conditions[key],
        dados: dados
      };
      dataTableIdx++;
    }
  }

  if (Object.keys(result).length < 4) {
    throw new Error(`Extraídas apenas ${Object.keys(result).length} tabelas válidas de 4 esperadas.`);
  }

  return result;
}

module.exports = { scrapeResolucao, fetchPage, parseHTMLTable, extractTableData };
