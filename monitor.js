// ======================================================
// MONITOR — Verificador de novas resoluções no DOU
// ======================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'monitor_state.json');

/**
 * Carrega o estado do monitor (última verificação, última resolução encontrada)
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }

  return {
    ultimaVerificacao: null,
    ultimaResolucao: {
      titulo: 'Resolução ANTT nº 6.084 de 16 de julho de 2026',
      url: 'https://www.in.gov.br/web/dou/-/resolucao-antt-n-6.084-de-16-de-julho-de-2026-719732378',
      data: '2026-07-16',
      id: '719732378'
    },
    novaResolucaoDisponivel: false,
    novaResolucao: null,
    historicoVerificacoes: []
  };
}

/**
 * Salva o estado do monitor
 */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Busca resoluções ANTT sobre frete no DOU
 */
function buscarDOU(termo) {
  return new Promise((resolve, reject) => {
    const searchTerms = encodeURIComponent(termo);
    const url = `https://www.in.gov.br/consulta/-/buscar/dou?q=${searchTerms}&s=0&sortType=0&delta=10&orgPrin=Agência+Nacional+de+Transportes+Terrestres+-+ANTT`;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      }
    };

    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Handle redirects
        https.get(res.headers.location, options, (res2) => {
          let body = '';
          res2.setEncoding('utf8');
          res2.on('data', chunk => body += chunk);
          res2.on('end', () => resolve(body));
        }).on('error', reject);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/**
 * Parseia os resultados de busca do DOU
 */
function parsearResultados(html) {
  const resultados = [];

  // Buscar links de resoluções ANTT
  const linkRegex = /href="(\/web\/dou\/-\/resolucao-antt[^"]+)"/gi;
  const titleRegex = /<a[^>]*class="[^"]*titulo[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = 'https://www.in.gov.br' + match[1];

    // Extrair ID da URL
    const idMatch = match[1].match(/(\d+)$/);
    const id = idMatch ? idMatch[1] : null;

    // Tentar extrair título
    const surroundingText = html.substring(
      Math.max(0, match.index - 300),
      Math.min(html.length, match.index + 500)
    );

    // Verificar se é sobre pisos mínimos de frete
    const isFreteRelated =
      surroundingText.toLowerCase().includes('piso') ||
      surroundingText.toLowerCase().includes('frete') ||
      surroundingText.toLowerCase().includes('coeficiente') ||
      surroundingText.toLowerCase().includes('carga');

    // Extrair texto do link
    const linkTextMatch = surroundingText.match(new RegExp(`href="${match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([^<]+)<`, 'i'));
    const titulo = linkTextMatch ? linkTextMatch[1].trim() : url;

    resultados.push({
      titulo,
      url,
      id,
      relevante: isFreteRelated
    });
  }

  return resultados;
}

/**
 * Verifica se há novas resoluções ANTT sobre frete
 */
async function verificarAtualizacao() {
  const state = loadState();

  try {
    // Buscar por diferentes termos
    const termos = [
      'resolução ANTT pisos mínimos frete',
      'resolução ANTT coeficientes piso frete rodoviário'
    ];

    let todosResultados = [];

    for (const termo of termos) {
      try {
        const html = await buscarDOU(termo);
        const resultados = parsearResultados(html);
        todosResultados = todosResultados.concat(resultados);
      } catch (e) {
        console.log(`[Monitor] Erro ao buscar "${termo}": ${e.message}`);
      }
    }

    // Remover duplicatas por URL
    const unique = {};
    todosResultados.forEach(r => { unique[r.url] = r; });
    const resultadosUnicos = Object.values(unique);

    // Verificar se algum resultado tem ID maior que o da última resolução conhecida
    const ultimoIdConhecido = parseInt(state.ultimaResolucao.id) || 0;
    const novos = resultadosUnicos.filter(r => {
      const rId = parseInt(r.id) || 0;
      return rId > ultimoIdConhecido && r.relevante;
    });

    // Atualizar estado
    state.ultimaVerificacao = new Date().toISOString();
    state.historicoVerificacoes.push({
      data: state.ultimaVerificacao,
      resultadosEncontrados: resultadosUnicos.length,
      novosEncontrados: novos.length
    });

    // Manter apenas as últimas 30 verificações
    if (state.historicoVerificacoes.length > 30) {
      state.historicoVerificacoes = state.historicoVerificacoes.slice(-30);
    }

    if (novos.length > 0) {
      state.novaResolucaoDisponivel = true;
      state.novaResolucao = novos[0]; // Pegar a mais recente
      console.log(`[Monitor] Nova resolução encontrada: ${novos[0].titulo}`);
    } else {
      state.novaResolucaoDisponivel = false;
      state.novaResolucao = null;
      console.log(`[Monitor] Nenhuma nova resolução encontrada.`);
    }

    saveState(state);

    return {
      verificadoEm: state.ultimaVerificacao,
      resolucaoAtual: state.ultimaResolucao,
      novaDisponivel: state.novaResolucaoDisponivel,
      novaResolucao: state.novaResolucao,
      totalResultados: resultadosUnicos.length,
      resultados: resultadosUnicos.slice(0, 10) // Top 10
    };
  } catch (e) {
    state.ultimaVerificacao = new Date().toISOString();
    state.historicoVerificacoes.push({
      data: state.ultimaVerificacao,
      erro: e.message
    });
    saveState(state);

    return {
      verificadoEm: state.ultimaVerificacao,
      resolucaoAtual: state.ultimaResolucao,
      novaDisponivel: state.novaResolucaoDisponivel,
      novaResolucao: state.novaResolucao,
      erro: e.message
    };
  }
}

/**
 * Retorna o estado atual (sem fazer nova busca)
 */
function getStatus() {
  return loadState();
}

/**
 * Marca que o usuário já atualizou para uma nova resolução
 */
function confirmarAtualizacao(novaResolucao) {
  const state = loadState();
  state.ultimaResolucao = novaResolucao;
  state.novaResolucaoDisponivel = false;
  state.novaResolucao = null;
  saveState(state);
}

module.exports = { verificarAtualizacao, getStatus, confirmarAtualizacao };
