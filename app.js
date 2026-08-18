// ======================================================
// CALCULADORA DE FRETE MÍNIMO ANTT
// Resolução 6.084 de 16 de Julho de 2026
// ======================================================

let TABELAS = null;
let TABELAS_PENDING = null;  // Tabelas pendentes de aprovação

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
  await carregarTabelas();
  setupEventListeners();
  setupUpdateListeners();
  renderTable('A');
});

async function carregarTabelas() {
  try {
    const resp = await fetch('tabelas_frete.json');
    TABELAS = await resp.json();
    if (TABELAS && TABELAS.resolucao) {
      document.getElementById('mainSubtitle').textContent = 'Resolução ' + TABELAS.resolucao;
      document.title = 'Calculadora de Frete Mínimo - Resolução ' + TABELAS.resolucao;
    }
  } catch (e) {
    console.error('Erro ao carregar tabelas:', e);
    alert('Erro ao carregar tabelas_frete.json. Verifique se o arquivo está na mesma pasta.');
  }
}

function atualizarSubtitulo() {
  if (TABELAS && TABELAS.resolucao) {
    document.getElementById('mainSubtitle').textContent = 'Resolução ' + TABELAS.resolucao;
    document.title = 'Calculadora de Frete Mínimo - Resolução ' + TABELAS.resolucao;
  }
}

function setupEventListeners() {
  // Calculator
  document.getElementById('btnCalcular').addEventListener('click', calcular);
  document.getElementById('chkComposicao').addEventListener('change', () => {
    document.getElementById('lblComposicao').textContent =
      document.getElementById('chkComposicao').checked ? 'Sim' : 'Não';
    calcular();
  });
  document.getElementById('chkRetornoVazio').addEventListener('change', () => {
    document.getElementById('lblRetornoVazio').textContent =
      document.getElementById('chkRetornoVazio').checked ? 'Sim' : 'Não';
    calcular();
  });
  document.getElementById('chkAltoDesempenho').addEventListener('change', () => {
    document.getElementById('lblAltoDesempenho').textContent =
      document.getElementById('chkAltoDesempenho').checked ? 'Sim' : 'Não';
    calcular();
  });
  document.getElementById('selTipoCarga').addEventListener('change', calcular);
  document.getElementById('selEixos').addEventListener('change', calcular);
  document.getElementById('inpDistancia').addEventListener('input', calcular);

  // Enter key
  document.getElementById('inpDistancia').addEventListener('keydown', e => {
    if (e.key === 'Enter') calcular();
  });

  // Tab bar
  document.querySelectorAll('#tabBar .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#tabBar .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderTable(tab.dataset.tab);
    });
  });

  // Export buttons removed

  // Modal
  document.getElementById('btnCloseModal').addEventListener('click', () => {
    document.getElementById('sqlModal').classList.add('hidden');
  });
  document.getElementById('sqlModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      document.getElementById('sqlModal').classList.add('hidden');
    }
  });
  document.getElementById('btnCopySQL').addEventListener('click', copiarSQL);
}

// ===== UPDATE MODAL LISTENERS =====
function setupUpdateListeners() {
  // Open/close update modal
  document.getElementById('btnAtualizar').addEventListener('click', () => {
    document.getElementById('updateModal').classList.remove('hidden');
    loadMonitorStatus();
  });
  document.getElementById('btnCloseUpdateModal').addEventListener('click', closeUpdateModal);
  document.getElementById('updateModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeUpdateModal();
  });

  // Method tabs
  document.querySelectorAll('.update-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.update-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const method = tab.dataset.method;
      document.getElementById('methodMonitor').classList.toggle('hidden', method !== 'monitor');
      document.getElementById('methodScraper').classList.toggle('hidden', method !== 'scraper');
      document.getElementById('methodOcr').classList.toggle('hidden', method !== 'ocr');
      
      // Mostrar ou esconder Edição Manual
      const manualPanel = document.getElementById('methodManual');
      if(manualPanel) manualPanel.style.display = method === 'manual' ? 'block' : 'none';
    });
  });
  // Monitor: verify
  document.getElementById('btnVerificarDOU').addEventListener('click', verificarDOU);

  // Scraper: extract
  document.getElementById('btnScrape').addEventListener('click', executarScraper);
  
  // OCR: Setup
  setupOcrListeners();
  
  // Manual Edit
  const btnManual = document.getElementById('btnOpenManualEdit');
  if(btnManual) {
    btnManual.addEventListener('click', () => {
      const tableId = document.getElementById('manualTableSelect').value;
      
      // Clone atual para TABELAS_PENDING
      TABELAS_PENDING = JSON.parse(JSON.stringify(TABELAS));
      
      // Esconder outras interfaces de metodo para limpar a tela visualmente (opcional)
      document.getElementById('methodManual').classList.add('hidden');
      document.querySelector('.update-tabs').classList.add('hidden');
      
      // Mostrar info success message genérica
      const headerMsg = document.getElementById('diffHeaderMsg');
      if(headerMsg) {
        headerMsg.innerHTML = `<span style="color:var(--text-primary)">Você está no Modo de Edição Manual (Tabela ${tableId}). Nenhuma alteração foi extraída. Edite diretamente abaixo.</span>`;
      }
      
      // Renderizar Grade
      showDiffPreview(tableId);
    });
  }
  
  // Grid Tabs
  document.querySelectorAll('.paste-tab[data-grid-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.paste-tab[data-grid-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderEditableGrid(tab.dataset.gridTab);
    });
  });
  // Diff: apply/cancel
  document.getElementById('btnApplyChanges').addEventListener('click', aplicarAlteracoes);
  document.getElementById('btnCancelChanges').addEventListener('click', () => {
    document.getElementById('diffPreview').classList.add('hidden');
    const mm = document.getElementById('methodManual');
    if(mm) mm.classList.remove('hidden');
    const ut = document.querySelector('.update-tabs');
    if(ut) ut.classList.remove('hidden');
    TABELAS_PENDING = null;
  });
}

function closeUpdateModal() {
  document.getElementById('updateModal').classList.add('hidden');
  document.getElementById('diffPreview').classList.add('hidden');
  const mm = document.getElementById('methodManual');
  if(mm) mm.classList.remove('hidden');
  const ut = document.querySelector('.update-tabs');
  if(ut) ut.classList.remove('hidden');
  TABELAS_PENDING = null;
}



function padArray(arr, length) {
  while (arr.length < length) arr.push(null);
  return arr.slice(0, length);
}

// ===== METHOD 2: MONITOR =====
async function loadMonitorStatus() {
  try {
    const resp = await fetch('/api/monitor-status');
    const data = await resp.json();
    updateMonitorUI(data);
  } catch (e) {
    document.getElementById('monResolucaoAtual').textContent = 'Erro ao carregar';
  }
}

async function verificarDOU() {
  const btn = document.getElementById('btnVerificarDOU');
  const loading = document.getElementById('monitorLoading');
  btn.disabled = true;
  loading.classList.remove('hidden');
  loading.innerHTML = '<span class="spinner"></span> Buscando no DOU...';

  try {
    const resp = await fetch('/api/verificar-atualizacao');
    const data = await resp.json();
    updateMonitorUI(data);

    // Show results
    if (data.resultados && data.resultados.length > 0) {
      const resultsDiv = document.getElementById('monitorResults');
      resultsDiv.classList.remove('hidden');
      let html = '<h4 style="font-size:0.85rem;margin-bottom:8px;">Resultados encontrados:</h4>';
      data.resultados.forEach(r => {
        html += `<div class="monitor-result-item">
          <span class="result-relevant ${r.relevante ? 'yes' : 'no'}">${r.relevante ? 'FRETE' : '—'}</span>
          <a href="${r.url}" target="_blank" class="result-url">${r.titulo}</a>
        </div>`;
      });
      resultsDiv.innerHTML = html;
    }

    if (data.novaDisponivel) {
      document.getElementById('updateBadge').classList.remove('hidden');
    }
  } catch (e) {
    loading.textContent = '❌ Erro: ' + e.message;
  } finally {
    btn.disabled = false;
    loading.classList.add('hidden');
  }
}

function updateMonitorUI(data) {
  if (data.ultimaResolucao || data.resolucaoAtual) {
    const res = data.resolucaoAtual || data.ultimaResolucao;
    document.getElementById('monResolucaoAtual').textContent = res.titulo || res.url;
  }
  if (data.ultimaVerificacao || data.verificadoEm) {
    const dt = new Date(data.ultimaVerificacao || data.verificadoEm);
    document.getElementById('monUltimaVerificacao').textContent = dt.toLocaleString('pt-BR');
  }
  const status = data.novaDisponivel || data.novaResolucaoDisponivel
    ? '🔔 Nova resolução disponível!'
    : '✅ Tabelas atualizadas';
  document.getElementById('monStatus').textContent = status;

  if (data.erro) {
    document.getElementById('monStatus').textContent = '⚠ ' + data.erro;
  }
}

// ===== METHOD 3: SCRAPER =====
async function executarScraper() {
  const url = document.getElementById('scraperUrl').value.trim();
  if (!url) {
    showToast('Informe a URL da resolução.');
    return;
  }

  const btn = document.getElementById('btnScrape');
  const loading = document.getElementById('scraperLoading');
  btn.disabled = true;
  loading.classList.remove('hidden');
  loading.innerHTML = '<span class="spinner"></span> Extraindo tabelas do DOU... Isso pode levar alguns segundos.';

  try {
    const resp = await fetch('/api/scraper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await resp.json();

    if (data.erro) {
      loading.textContent = '❌ ' + data.erro;
      loading.classList.remove('hidden');
      return;
    }

    // Build pending tabelas from scraped data
    TABELAS_PENDING = JSON.parse(JSON.stringify(TABELAS));
    for (const key of ['A', 'B', 'C', 'D']) {
      if (data.tabelas[key]) {
        TABELAS_PENDING.tabelas[key].dados = data.tabelas[key].dados;
      }
    }

    loading.textContent = '✅ 4 tabelas extraídas com sucesso!';
    showDiffPreview();
  } catch (e) {
    loading.textContent = '❌ Erro: ' + e.message;
    loading.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

// ===== METHOD 4: OCR (Tesseract.js / PDF.js) =====
let ocrSelectedFile = null;

function setupOcrListeners() {
  const uploadArea = document.getElementById('ocrUploadArea');
  const fileInput = document.getElementById('ocrFileInput');
  const btnProcess = document.getElementById('btnProcessOcr');

  uploadArea.addEventListener('click', () => fileInput.click());
  
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });
  
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleOcrFileSelection(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
      handleOcrFileSelection(e.target.files[0]);
    }
  });

  btnProcess.addEventListener('click', processOcr);
}

function handleOcrFileSelection(file) {
  ocrSelectedFile = file;
  const p = document.querySelector('#ocrUploadArea p');
  const subtext = document.querySelector('#ocrUploadArea .ocr-subtext');
  
  p.textContent = `Arquivo selecionado: ${file.name}`;
  p.style.color = 'var(--success)';
  subtext.textContent = `(${Math.round(file.size / 1024)} KB)`;
  
  document.getElementById('ocrControls').classList.remove('hidden');
}

async function processOcr() {
  if (!ocrSelectedFile) return;

  const tableId = document.getElementById('ocrTableSelect').value;
  const progressDiv = document.getElementById('ocrProgress');
  const progressBar = document.getElementById('ocrProgressBar');
  const statusText = document.getElementById('ocrStatusText');
  
  document.getElementById('ocrControls').classList.add('hidden');
  progressDiv.classList.remove('hidden');
  progressBar.style.width = '10%';
  statusText.textContent = 'Preparando imagem para envio ao servidor...';
  
  try {
    let base64Image = null;
    
    // Se for PDF, converter a primeira página em imagem usando PDF.js
    if (ocrSelectedFile.type === 'application/pdf') {
      statusText.textContent = 'Convertendo PDF para imagem (alta resolução)...';
      progressBar.style.width = '20%';
      
      const fileUrl = URL.createObjectURL(ocrSelectedFile);
      const pdf = await pdfjsLib.getDocument(fileUrl).promise;
      const page = await pdf.getPage(1);
      
      // Escala 3.0 para máxima resolução no OCR
      const viewport = page.getViewport({ scale: 3.0 });
      const canvas = document.getElementById('pdfCanvas');
      const ctx = canvas.getContext('2d');
      
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      base64Image = canvas.toDataURL('image/png');
      URL.revokeObjectURL(fileUrl);
    } else {
      // Se for imagem, renderizar no canvas com escala de 3x para melhorar resolucao do OCR
      statusText.textContent = 'Tratando resolução da imagem...';
      const fileUrl = URL.createObjectURL(ocrSelectedFile);
      const img = new Image();
      img.src = fileUrl;
      await new Promise(res => img.onload = res);
      
      const canvas = document.getElementById('pdfCanvas');
      const ctx = canvas.getContext('2d');
      const scale = 3.0; // Aumentar a resolucao para ajudar a IA
      
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      // Filtro para aumentar contraste (opcional, mas ajuda)
      ctx.filter = 'contrast(1.5) grayscale(1)';
      ctx.drawImage(canvas, 0, 0); // Re-draw over itself to apply filter
      
      base64Image = canvas.toDataURL('image/png');
      URL.revokeObjectURL(fileUrl);
    }
    
    statusText.textContent = 'Enviando imagem ao servidor para processamento OCR...';
    progressBar.style.width = '40%';
    
    // Enviar ao servidor
    const resp = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64Image, tableId })
    });
    
    progressBar.style.width = '80%';
    statusText.textContent = 'Processando resultado...';
    
    const data = await resp.json();
    
    if (data.erro) {
      throw new Error(data.erro);
    }
    
    progressBar.style.width = '100%';
    
    const count = data.cargasEncontradas || Object.keys(data.dados).length;
    
    if (count > 0) {
      if (!TABELAS_PENDING) {
        TABELAS_PENDING = JSON.parse(JSON.stringify(TABELAS));
      }
      TABELAS_PENDING.tabelas[tableId].dados = data.dados;
      showDiffPreview(tableId);
      statusText.innerHTML = `<span style="color:var(--success)">✅ Sucesso! ${count} cargas extraídas da Tabela ${tableId}. <strong>Revise os valores na grade abaixo e corrija se necessário.</strong></span>`;
    } else {
      statusText.innerHTML = `<span style="color:var(--danger)">❌ Nenhum dado válido encontrado na imagem. Tente uma imagem com melhor resolução.</span>`;
      document.getElementById('ocrControls').classList.remove('hidden');
    }
    
  } catch (e) {
    statusText.innerHTML = `<span style="color:var(--danger)">❌ Erro OCR: ${e.message}</span>`;
    document.getElementById('ocrControls').classList.remove('hidden');
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
// ===== DIFF ENGINE (EDITABLE GRID) =====
function showDiffPreview(activeTabId = 'A') {
  if (!TABELAS_PENDING || !TABELAS) return;
  document.getElementById('diffPreview').classList.remove('hidden');
  
  // Ativar aba correspondente
  document.querySelectorAll('.paste-tab[data-grid-tab]').forEach(t => t.classList.remove('active'));
  document.querySelector(`.paste-tab[data-grid-tab="${activeTabId}"]`)?.classList.add('active');
  
  renderEditableGrid(activeTabId);
}

function renderEditableGrid(tKey) {
  if (!TABELAS_PENDING) return;
  
  const eixos = TABELAS.eixos;
  const oldData = TABELAS.tabelas[tKey].dados;
  const newData = TABELAS_PENDING.tabelas[tKey].dados;
  const tiposCarga = TABELAS.tiposCarga;
  
  let changed = 0, same = 0, added = 0;
  let html = `
    <table class="diff-table">
      <thead>
        <tr>
          <th style="width: 250px;">Tipo de Carga</th>
          <th>Coef.</th>
        <tr>
          <th style="width: 250px;">Tipo de Carga</th>
          <th style="text-align: center;">Coef.</th>
          ${eixos.map(e => `<th style="text-align: center;">${e} Eixos</th>`).join('')}
        </tr>
  `;
  
  for (const carga of tiposCarga) {
    const cargoId = carga.id;
    const oldCCD = oldData[cargoId]?.CCD || padArray([], 7);
    const oldCC = oldData[cargoId]?.CC || padArray([], 7);
    const newCCD = newData[cargoId]?.CCD || padArray([], 7);
    const newCC = newData[cargoId]?.CC || padArray([], 7);
    
    // Linha CCD
    html += `<tr>
      <td rowspan="2" style="font-weight:600; border-bottom:1px solid var(--border);">${carga.id}. ${carga.nome}</td>
      <td style="color:var(--text-muted)">CCD</td>`;
      
    for (let e = 0; e < eixos.length; e++) {
      const oVal = oldCCD[e];
      const nVal = newCCD[e];
      let cellClass = '';
      if (oVal === null && nVal !== null) { added++; cellClass = 'diff-row-new'; }
      else if (oVal !== nVal) { changed++; cellClass = 'diff-row-changed'; }
      else { same++; }
      
      html += `<td class="${cellClass}" style="text-align: center;">
        <input type="number" step="0.0001" class="grid-input" 
          data-table="${tKey}" data-cargo="${cargoId}" data-coef="CCD" data-eixo="${e}" 
          value="${nVal !== null ? nVal : ''}">
      </td>`;
    }
    // Linha CC
    html += `<tr><td style="color:var(--text-muted); border-bottom:1px solid var(--border);">CC</td>`;
    for (let e = 0; e < eixos.length; e++) {
      const oVal = oldCC[e];
      const nVal = newCC[e];
      let cellClass = '';
      if (oVal === null && nVal !== null) { added++; cellClass = 'diff-row-new'; }
      else if (oVal !== nVal) { changed++; cellClass = 'diff-row-changed'; }
      else { same++; }
      
      html += `<td class="${cellClass}" style="border-bottom:1px solid var(--border); text-align: center;">
        <input type="number" step="0.01" class="grid-input" 
          data-table="${tKey}" data-cargo="${cargoId}" data-coef="CC" data-eixo="${e}" 
          value="${nVal !== null ? nVal : ''}">
      </td>`;
    }
  }
  
  html += `</tbody></table>`;
  document.getElementById('diffTableContainer').innerHTML = html;
  
  // Atualizar Stats globais de todas as tabelas
  updateDiffStats();
  
  // Add Event Listeners for inputs
  document.querySelectorAll('.grid-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const t = e.target.dataset.table;
      const c = e.target.dataset.cargo;
      const coef = e.target.dataset.coef;
      const eixoIdx = parseInt(e.target.dataset.eixo);
      const val = e.target.value === '' ? null : parseFloat(e.target.value);
      
      if (!TABELAS_PENDING.tabelas[t].dados[c]) {
        TABELAS_PENDING.tabelas[t].dados[c] = { CCD: padArray([], 7), CC: padArray([], 7) };
      }
      
      TABELAS_PENDING.tabelas[t].dados[c][coef][eixoIdx] = val;
      updateDiffStats();
      
      // Update cell styling visually
      const oldVal = TABELAS.tabelas[t].dados[c]?.[coef]?.[eixoIdx] || null;
      const td = e.target.parentElement;
      td.className = '';
      if (oldVal === null && val !== null) td.className = 'diff-row-new';
      else if (oldVal !== val) td.className = 'diff-row-changed';
    });
  });
}

function updateDiffStats() {
  if (!TABELAS_PENDING || !TABELAS) return;
  let changed = 0, same = 0, added = 0;
  
  for (const tKey of ['A', 'B', 'C', 'D']) {
    const oldData = TABELAS.tabelas[tKey].dados;
    const newData = TABELAS_PENDING.tabelas[tKey].dados;

    for (const cargoId of Object.keys(newData)) {
      for (const coef of ['CCD', 'CC']) {
        const oldArr = oldData[cargoId]?.[coef] || [];
        const newArr = newData[cargoId]?.[coef] || [];

        for (let e = 0; e < 7; e++) {
          const oldVal = oldArr[e];
          const newVal = newArr[e];

          if (oldVal === newVal) { same++; }
          else if (oldVal === null && newVal !== null) { added++; }
          else { changed++; }
        }
      }
    }
  }

  document.getElementById('diffStats').innerHTML = `
    <div class="diff-stat changed">⚡ ${changed} alterados</div>
    <div class="diff-stat new">✚ ${added} novos</div>
    <div class="diff-stat same">= ${same} iguais</div>
  `;
}

async function aplicarAlteracoes() {
  if (!TABELAS_PENDING) return;

  // Ler metadados da tela
  const resMeta = document.getElementById('inpMetaResolucao').value.trim();
  const pubMeta = document.getElementById('inpMetaPublicacao').value;
  const vigMeta = document.getElementById('inpMetaVigencia').value;

  if (!resMeta || !pubMeta || !vigMeta) {
    showToast('Por favor, preencha os dados da Resolução!');
    return;
  }

  const btn = document.getElementById('btnApplyChanges');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sincronizando...';

  TABELAS_PENDING.metadata = {
    resolucao: resMeta,
    dataPublicacao: pubMeta,
    inicioVigencia: vigMeta
  };

  // Atualiza o subtítulo formatado no formato "Resolução ANTT nº XXXX/XXXX — XX de XXXXX de XXXX"
  const dateParts = pubMeta.split('-');
  if (dateParts.length === 3) {
    const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const nomeMes = meses[parseInt(dateParts[1], 10) - 1];
    TABELAS_PENDING.resolucao = `ANTT nº ${resMeta} — ${dateParts[2]} de ${nomeMes} de ${dateParts[0]}`;
  } else {
    TABELAS_PENDING.resolucao = `ANTT nº ${resMeta}`;
  }

  try {
    // 1. Salvar localmente
    const resp = await fetch('/api/salvar-tabelas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TABELAS_PENDING)
    });
    const data = await resp.json();

    if (data.sucesso) {
      // 2. Sincronizar com ERP Delphi (SQL Server)
      try {
        const syncResp = await fetch('/api/sync-sqlserver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(TABELAS_PENDING)
        });
        const syncData = await syncResp.json();
        if(!syncData.sucesso) {
           console.error('Aviso: Erro ao sincronizar SQL:', syncData.erro);
           showToast(`Salvo local. Porém falhou ao enviar pro ERP: ${syncData.erro}`);
        }
      } catch(e) {
        console.error('Falha de rede ao sincronizar SQL:', e);
      }

      TABELAS = TABELAS_PENDING;
      TABELAS_PENDING = null;
      PASTE_DATA = { A: null, B: null, C: null, D: null };

      // Re-render
      const activeTab = document.querySelector('#tabBar .tab.active')?.dataset.tab || 'A';
      renderTable(activeTab);
      calcular();
      atualizarSubtitulo();

      closeUpdateModal();
      showToast(`Tabelas sincronizadas no ERP Delphi e salvas localmente!`);
    } else {
      showToast('Erro: ' + (data.erro || 'Falha desconhecida'));
    }
  } catch (e) {
    showToast('Erro ao salvar: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ===== CALCULATOR =====
function getSelectedTable() {
  const composicao = document.getElementById('chkComposicao').checked;
  const alto = document.getElementById('chkAltoDesempenho').checked;

  if (composicao && !alto) return 'A';
  if (!composicao && !alto) return 'B';
  if (composicao && alto) return 'C';
  if (!composicao && alto) return 'D';
  return 'A';
}

function getEixosIndex(eixos) {
  const map = { 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 9: 6 };
  return map[eixos] !== undefined ? map[eixos] : -1;
}

function calcular() {
  if (!TABELAS) return;

  const tabelaKey = getSelectedTable();
  const tipoCarga = document.getElementById('selTipoCarga').value;
  const eixos = parseInt(document.getElementById('selEixos').value);
  const distancia = parseFloat(document.getElementById('inpDistancia').value) || 0;

  const tabela = TABELAS.tabelas[tabelaKey];
  const dados = tabela.dados[tipoCarga];
  const idx = getEixosIndex(eixos);

  const resultPanel = document.getElementById('result-panel');

  if (!dados || idx < 0) {
    resultPanel.classList.add('hidden');
    return;
  }

  let ccd = dados.CCD[idx];
  let cc = dados.CC[idx];
  let fallbackUsado = false;
  let eixosUsados = eixos;

  if (ccd === null || cc === null) {
    // Tenta encontrar o imediatamente inferior
    let encontrado = false;
    let fallbackEixos = -1;
    let fallbackIdx = -1;
    
    const todasOpcoes = [2, 3, 4, 5, 6, 7, 9];
    
    // Procurar imediatamente inferior
    for (let i = todasOpcoes.length - 1; i >= 0; i--) {
      if (todasOpcoes[i] < eixos) {
        let iIdx = getEixosIndex(todasOpcoes[i]);
        if (dados.CCD[iIdx] !== null && dados.CC[iIdx] !== null) {
           fallbackIdx = iIdx;
           fallbackEixos = todasOpcoes[i];
           encontrado = true;
           break;
        }
      }
    }
    
    // Se não achou inferior, procurar o imediatamente superior
    if (!encontrado) {
       for (let i = 0; i < todasOpcoes.length; i++) {
         if (todasOpcoes[i] > eixos) {
           let iIdx = getEixosIndex(todasOpcoes[i]);
           if (dados.CCD[iIdx] !== null && dados.CC[iIdx] !== null) {
             fallbackIdx = iIdx;
             fallbackEixos = todasOpcoes[i];
             encontrado = true;
             break;
           }
         }
       }
    }

    if (encontrado) {
      ccd = dados.CCD[fallbackIdx];
      cc = dados.CC[fallbackIdx];
      eixosUsados = fallbackEixos;
      fallbackUsado = true;
    }
  }

  if (ccd === null || cc === null) {
    document.getElementById('resultCCD').textContent = '—';
    document.getElementById('resultCC').textContent = '—';
    document.getElementById('resultTotal').textContent = 'N/D';
    document.getElementById('resultFormula').innerHTML =
      '<strong style="color:var(--danger)">⚠ Combinação não disponível:</strong> Não existem coeficientes para ' +
      eixos + ' eixos com esse tipo de carga na ' + tabela.descricao + '.';
    document.getElementById('resultTabela').textContent = 'TABELA ' + tabelaKey;
    document.getElementById('resultDescricao').textContent = tabela.descricao;
    resultPanel.classList.remove('hidden');
    return;
  }

  let ida = (ccd * distancia) + cc;
  let retornoVazio = 0;
  if (document.getElementById('chkRetornoVazio').checked) {
    retornoVazio = 0.92 * distancia * ccd;
  }
  let total = ida + retornoVazio;

  document.getElementById('resultCCD').textContent = formatCurrency(ccd, 4);
  document.getElementById('resultCC').textContent = formatCurrency(cc);
  document.getElementById('resultTotal').textContent = formatCurrency(total);

  document.getElementById('resultTabela').textContent = 'TABELA ' + tabelaKey;
  document.getElementById('resultDescricao').textContent = tabela.descricao;

  const tipoCargaNome = TABELAS.tiposCarga.find(t => t.id == tipoCarga)?.nome || '';
  let formulaHtml = '';
  if (fallbackUsado) {
    formulaHtml += `<strong style="color:#d97706;">⚠ Atenção:</strong> Não existem coeficientes para ${eixos} eixos com esse tipo de carga na ${tabela.descricao}. O cálculo foi realizado utilizando os valores referentes a ${eixosUsados} eixos, conforme regra da ANTT.<br><br>`;
  }

  formulaHtml += `<strong>Frete Mínimo</strong> = (CCD × Distância) + CC\n` +
    `<strong>Frete Mínimo</strong> = (${formatNum(ccd, 4)} × ${formatNum(distancia, 1)} km) + ${formatCurrency(cc)}\n` +
    `<strong>Frete Mínimo</strong> = ${formatCurrency(ccd * distancia)} + ${formatCurrency(cc)} = <strong>${formatCurrency(total)}</strong>\n\n` +
    `Tabela ${tabelaKey} | ${tipoCargaNome} | ${eixos} eixos | ${formatNum(distancia, 1)} km`;

  document.getElementById('resultFormula').innerHTML = formulaHtml;

  resultPanel.classList.remove('hidden');

  // Highlight on visible table
  highlightTableCell(tabelaKey, tipoCarga, idx);
}

function highlightTableCell(tabelaKey, tipoCarga, eixosIdx) {
  // Remove previous highlights
  document.querySelectorAll('.cell-highlight').forEach(el => el.classList.remove('cell-highlight'));

  const activeTab = document.querySelector('#tabBar .tab.active')?.dataset.tab;
  if (activeTab !== tabelaKey) return;

  // Find the right row — cargo type 1 = rows 0-1, cargo type 2 = rows 2-3, etc.
  const rowStart = (parseInt(tipoCarga) - 1) * 2;
  const table = document.querySelector('.data-table');
  if (!table) return;

  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const rows = tbody.querySelectorAll('tr');
  const colOffset = 3; // id, nome, coeficiente

  // CCD row
  if (rows[rowStart]) {
    const cell = rows[rowStart].querySelectorAll('td')[colOffset + eixosIdx];
    if (cell) cell.classList.add('cell-highlight');
  }
  // CC row
  if (rows[rowStart + 1]) {
    const cell = rows[rowStart + 1].querySelectorAll('td')[1 + eixosIdx]; // Correct offset (no rowspan)
    if (cell) cell.classList.add('cell-highlight');
  }
}
// ===== TABLE RENDER =====
function renderTable(tabelaKey) {
  if (!TABELAS) return;

  const tabela = TABELAS.tabelas[tabelaKey];
  document.getElementById('tableDescription').textContent = tabela.descricao;

  const eixos = TABELAS.eixos;
  let html = '<table class="data-table"><thead><tr>';
  html += '<th>#</th><th>Tipo de Carga</th><th>Coef.</th>';
  eixos.forEach(e => html += `<th>${e} eixos</th>`);
  html += '</tr></thead><tbody>';

  TABELAS.tiposCarga.forEach(tipo => {
    const dados = tabela.dados[tipo.id.toString()];
    if (!dados) return;

    // CCD row
    html += `<tr class="row-ccd">`;
    html += `<td rowspan="2">${tipo.id}</td>`;
    html += `<td rowspan="2">${tipo.nome}</td>`;
    html += `<td>R$/km <span style="font-size: 0.85em; opacity: 0.6; font-weight: normal;">(CCD)</span></td>`;
    dados.CCD.forEach(v => {
      if (v === null) {
        html += `<td class="cell-empty">—</td>`;
      } else {
        html += `<td>${formatNum(v, 4)}</td>`;
      }
    });
    html += '</tr>';

    // CC row
    html += `<tr class="row-cc">`;
    html += `<td>R$ <span style="font-size: 0.85em; opacity: 0.6; font-weight: normal;">(CC)</span></td>`;
    dados.CC.forEach(v => {
      if (v === null) {
        html += `<td class="cell-empty">—</td>`;
      } else {
        html += `<td>${formatNum(v, 2)}</td>`;
      }
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  document.getElementById('tableContainer').innerHTML = html;

  // Re-highlight if needed
  const tipoCarga = document.getElementById('selTipoCarga').value;
  const eixosVal = parseInt(document.getElementById('selEixos').value);
  const selectedTable = getSelectedTable();
  if (selectedTable === tabelaKey) {
    highlightTableCell(tabelaKey, tipoCarga, getEixosIndex(eixosVal));
  }
}

// ===== EXPORT SQL =====
function exportarSQL() {
  if (!TABELAS) return;

  const eixos = TABELAS.eixos;
  let sql = '';

  sql += '/* =============================================================\n';
  sql += '   TABELAS DE FRETE MÍNIMO — Resolução ANTT 6.084/2026\n';
  sql += '   Gerado automaticamente pela Calculadora de Frete Mínimo\n';
  sql += '   ============================================================= */\n\n';

  let idTabela = 1;
  ['A', 'B', 'C', 'D'].forEach(tabelaKey => {
    const tabela = TABELAS.tabelas[tabelaKey];
    sql += `\n/* TABELA ${tabelaKey} — ${tabela.descricao} */\n`;
    
    const desc = tabela.descricao.replace(/'/g, "''");
    sql += `INSERT INTO FA_CIOT_TABELA_CADASTRO (ID_TABELA, DESCRICAO, TIPO_TABELA, NR_RESOLUCAO, DATA_PUBLICACAO, INICIO_VIGENCIA, FIM_VIGENCIA)\n`;
    // Datas preenchidas com as datas reais da Resolução 6.084 como exemplo
    sql += `VALUES (${idTabela}, '${desc}', '${tabelaKey}', '6.084', '2026-07-16', '2026-07-20', NULL);\n\n`;

    TABELAS.tiposCarga.forEach(tipo => {
      const dados = tabela.dados[tipo.id.toString()];
      if (!dados) return;

      eixos.forEach((numEixos, idx) => {
        const ccd = dados.CCD[idx];
        const cc = dados.CC[idx];
        if (ccd === null && cc === null) return;

        const ccdStr = ccd !== null ? ccd.toFixed(4) : 'NULL';
        const ccStr = cc !== null ? cc.toFixed(2) : 'NULL';

        sql += `INSERT INTO FA_CIOT_TABELA_VALORES (ID_TABELA, ID_TIPO_CARGA, NR_EIXOS, CCD_VALOR, CC_VALOR) `;
        sql += `VALUES (${idTabela}, ${tipo.id}, ${numEixos}, ${ccdStr}, ${ccStr});\n`;
      });
    });
    idTabela++;
  });

  sql += '\n\nCOMMIT;\n';

  // Show modal
  document.getElementById('sqlOutput').value = sql;
  document.getElementById('sqlModal').classList.remove('hidden');
}

function copiarSQL() {
  const textarea = document.getElementById('sqlOutput');
  textarea.select();
  document.execCommand('copy');
  showToast('SQL copiado para a área de transferência!');
}

// ===== EXPORT JSON =====
function exportarJSON() {
  if (!TABELAS) return;
  const blob = new Blob([JSON.stringify(TABELAS, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tabelas_frete_antt_6084_2026.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('JSON exportado com sucesso!');
}

// ===== UTILITIES =====
function formatNum(value, decimals = 2) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatCurrency(value, decimals = 2) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// AUTO-SHUTDOWN HEARTBEAT
setInterval(() => {
  if (document.hidden) return; // Se a janela foi fechada mas o Chrome manteve em background, corta o pulso!
  fetch('/api/heartbeat').catch(err => console.log('Server ping failed'));
}, 3000);

// VEREDAS THEME TOGGLE
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const htmlEl = document.documentElement;
let currentTheme = localStorage.getItem('theme') || 'light';

function applyTheme(theme) {
  htmlEl.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  if (theme === 'dark') {
    // Moon Icon
    themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"></path>';
  } else {
    // Sun Icon
    themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
  }
}

applyTheme(currentTheme);

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(currentTheme);
  });
}