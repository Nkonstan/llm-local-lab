// ─────────────────────────────────────────────────────────────────────────────
//  Lab App — "Manage Models" modal (merged)
//
//  This used to be two different modals in two different apps:
//    - Lab UI:   a "Browse & Pull Models" library (search, category tabs, a
//                curated catalog with a size picker, per-card pull progress).
//    - Lab Eval: a simpler "Manage Models" modal — type a name, pull it, see
//                a progress bar, and a list of installed models each with its
//                own delete button (behind the shared confirmation modal).
//
//  Now that Chat/A-B-Diff/Eval-Harness are one app with one set of model
//  dropdowns, there's no reason to have two separate places to manage
//  models with two different affordances. This merges them into one modal:
//  the richer library browser (this file's biggest piece, taken from Lab
//  UI) plus an "Installed Models" section underneath it with delete buttons
//  (taken from Lab Eval), sharing ONE pull-progress bar and ONE delete
//  confirmation flow. Lab Eval's plain "type a name" pull box is dropped —
//  Lab UI's custom-name input at the bottom of the library browser already
//  covers that job, and now it reports progress through the shared bar
//  instead of firing a toast with no progress feedback.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml } from '../../shared/markdown.js';
import { pullModel, deleteModel } from '../../shared/api-client.js';
import { BUNDLED_MODELS } from './bundled-models.js';

const CATEGORIES = ['All', 'General', 'Reasoning', 'Coding', 'Vision', 'Embedding', 'Compact', 'Uncensored'];

export function formatPulls(n) {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M pulls`;
  if (n >= 1_000)     return `${(n/1_000).toFixed(0)}K pulls`;
  return `${n} pulls`;
}

export function initModelCatalog({ baseUrl, showToast, loadModels }) {
  let allLibraryModels = BUNDLED_MODELS;
  let localModelNames  = new Set();
  let activeCategory   = 'All';

  const $manageModelsBtn = document.getElementById('manage-models-btn');
  const $overlay         = document.getElementById('models-modal-overlay');
  const $modalClose      = document.getElementById('models-modal-close');

  // ── Library browser (search / categories / cards) ─────────────────────────
  const $modalList     = document.getElementById('modal-list');
  const $modalStatus    = document.getElementById('modal-status');
  const $modalSearch    = document.getElementById('modal-search');
  const $modalTabs      = document.getElementById('modal-tabs');
  const $customInput    = document.getElementById('modal-custom-input');
  const $pullCustomBtn  = document.getElementById('modal-pull-custom');

  // ── Shared pull-progress bar (used by the custom-name pull below) ─────────
  const $pullProgress = document.getElementById('models-pull-progress');
  const $pullStatus   = document.getElementById('models-pull-status');
  const $pullBar       = document.getElementById('models-pull-bar');

  // ── Installed models (list + delete) ──────────────────────────────────────
  const $installedList = document.getElementById('models-installed-list');

  // Build category tabs once
  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'modal-tab' + (cat === 'All' ? ' active' : '');
    btn.textContent = cat;
    btn.dataset.cat = cat;
    btn.addEventListener('click', () => {
      activeCategory = cat;
      $modalSearch.value = '';
      document.querySelectorAll('.modal-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
      renderModelList('');
    });
    $modalTabs.appendChild(btn);
  });

  function openModelsModal() {
    $overlay.classList.add('open');
    $modalSearch.value = '';
    $modalSearch.focus();
    localModelNames = new Set(Array.from(localModelNames));
    renderModelList('');
  }

  function closeModelsModal() {
    $overlay.classList.remove('open');
  }

  function renderModelList(query) {
    const q = query.toLowerCase().trim();

    let filtered = activeCategory === 'All'
      ? allLibraryModels
      : allLibraryModels.filter(m => m.category === activeCategory);

    if (q) {
      filtered = filtered.filter(m =>
        m.model_name?.toLowerCase().includes(q) ||
        m.model_identifier?.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q)
      );
    }

    const total = activeCategory === 'All' ? allLibraryModels.length : allLibraryModels.filter(m => m.category === activeCategory).length;
    $modalStatus.textContent = q
      ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''} for "${query}"`
      : `${filtered.length} model${filtered.length !== 1 ? 's' : ''} · click to pull`;

    if (filtered.length === 0) {
      $modalList.innerHTML = '<div class="modal-empty">No models match your search.</div>';
      return;
    }

    $modalList.innerHTML = '';
    for (const m of filtered) {
      const isInstalled = localModelNames.has(m.model_identifier);
      const card = document.createElement('div');
      card.className = 'model-card' + (isInstalled ? ' already-have' : '');
      card.dataset.modelId = m.model_identifier;
      card.innerHTML = `
        <div class="model-card-info">
          <div class="model-card-name">
            ${escHtml(m.model_name || m.model_identifier)}
            ${isInstalled ? '<span class="model-badge installed">installed</span>' : ''}
            ${m.category && activeCategory === 'All' ? `<span class="model-badge cat-${escHtml(m.category.toLowerCase())}">${escHtml(m.category)}</span>` : ''}
          </div>
          <div class="model-card-sizes">${(m.labels || []).map(l => `<span class="size-pill">${escHtml(l)}</span>`).join('')}</div>
          <div class="model-card-desc">${escHtml(m.description || '')}</div>
        </div>
        <div class="model-card-meta">${escHtml(formatPulls(m.pulls))}</div>
      `;
      if (!isInstalled) {
        card.addEventListener('click', () => openSizePicker(m, card));
      }
      $modalList.appendChild(card);
    }
  }

  // ── Size picker ───────────────────────────────────────────────────────────

  function openSizePicker(model, cardEl) {
    document.getElementById('size-picker')?.remove();

    const labels = model.labels || [];

    if (labels.length <= 1) {
      const tag = labels.length === 1 ? `${model.model_identifier}:${labels[0]}` : model.model_identifier;
      startPullOnCard(model.model_identifier, tag, cardEl);
      return;
    }

    const picker = document.createElement('div');
    picker.id = 'size-picker';
    picker.innerHTML = `
      <div class="sp-arrow"></div>
      <div class="sp-title">Choose a size to pull</div>
      <div class="sp-hint">Larger = smarter but needs more RAM/VRAM</div>
      <div class="sp-sizes">
        ${labels.map(l => `<button class="sp-btn" data-tag="${escHtml(model.model_identifier)}:${escHtml(l)}">${escHtml(l)}</button>`).join('')}
        <button class="sp-btn sp-default" data-tag="${escHtml(model.model_identifier)}">default</button>
      </div>
    `;

    cardEl.style.position = 'relative';
    cardEl.appendChild(picker);

    picker.querySelectorAll('.sp-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tag = btn.dataset.tag;
        picker.remove();
        startPullOnCard(model.model_identifier, tag, cardEl);
      });
    });

    setTimeout(() => {
      document.addEventListener('click', closeSizePickerOnOutside, { once: true });
    }, 0);
  }

  function closeSizePickerOnOutside(e) {
    const picker = document.getElementById('size-picker');
    if (picker && !picker.contains(e.target)) {
      picker.remove();
    }
  }

  async function startPullOnCard(modelId, fullTag, cardEl) {
    cardEl.style.position = '';
    cardEl.classList.add('pulling');
    const metaEl = cardEl.querySelector('.model-card-meta');

    metaEl.innerHTML = `
      <div class="pull-progress">
        <div class="pull-progress-row">
          <div class="pull-spinner"></div>
          <span class="pull-status-text">Starting…</span>
        </div>
        <div class="pull-bar-track">
          <div class="pull-bar-fill" id="pull-bar-${escHtml(modelId)}"></div>
        </div>
      </div>`;

    const barEl   = document.getElementById(`pull-bar-${modelId}`);
    const labelEl = metaEl.querySelector('.pull-status-text');

    function onProgress(status, pct) {
      if (barEl)   barEl.style.width = pct + '%';
      if (labelEl) labelEl.textContent = pct < 100 ? `${status} ${pct}%` : status;
    }

    try {
      await doPull(fullTag, onProgress);
      cardEl.classList.remove('pulling');
      cardEl.classList.add('already-have');
      const nameEl = cardEl.querySelector('.model-card-name');
      if (!nameEl.querySelector('.model-badge.installed')) {
        nameEl.insertAdjacentHTML('beforeend', '<span class="model-badge installed">installed</span>');
      }
      metaEl.textContent = '';
      localModelNames.add(modelId);
    } catch {
      cardEl.classList.remove('pulling');
      metaEl.textContent = formatPulls(0);
    }
  }

  async function doPull(modelName, onProgress) {
    showToast(`Pulling ${modelName}…`);
    try {
      await pullModel(baseUrl, modelName, onProgress);
      await loadModels();
      showToast(`✅ ${modelName} ready — select it in any panel`);
    } catch (e) {
      showToast(`❌ Pull failed: ${e.message}`);
      throw e;
    }
  }

  // ── Custom-name pull — reports through the shared progress bar rather than
  //    a toast-only flow, so pulling something not in the curated library
  //    (or a size Lab doesn't know about) gets the same live feedback a
  //    library card pull does. ──────────────────────────────────────────────

  async function doCustomPull(modelName) {
    $pullProgress.classList.add('active');
    $pullStatus.textContent = 'Starting…';
    $pullBar.style.width = '0%';
    try {
      await doPull(modelName, (status, pct) => {
        $pullStatus.textContent = pct < 100 ? `${status} (${pct}%)` : status;
        $pullBar.style.width = `${pct}%`;
      });
    } catch {
      // doPull() already toasted the failure — nothing further to do here.
    } finally {
      $pullProgress.classList.remove('active');
    }
  }

  // ── Installed models list + delete ─────────────────────────────────────────

  function renderInstalledModelsList(models) {
    localModelNames = new Set((models || []).map(m => m.name.split(':')[0]));

    if (!models || models.length === 0) {
      $installedList.innerHTML = '<div class="modal-empty">No models pulled yet.</div>';
      return;
    }
    $installedList.innerHTML = '';
    models.forEach(m => {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `
        <span class="model-row-name">${escHtml(m.name)}</span>
        <button class="model-row-delete" data-model="${escHtml(m.name)}">🗑 Delete</button>
      `;
      row.querySelector('.model-row-delete').addEventListener('click', () => openDeleteModal(m.name));
      $installedList.appendChild(row);
    });

    // If the library browser is currently showing, refresh its "installed"
    // badges too — a pull/delete from either half of the modal should be
    // reflected in both.
    if ($overlay.classList.contains('open')) renderModelList($modalSearch.value);
  }

  // ── Wire modal events ────────────────────────────────────────────────────

  $manageModelsBtn.addEventListener('click', openModelsModal);
  $modalClose.addEventListener('click', closeModelsModal);
  $overlay.addEventListener('click', e => { if (e.target === $overlay) closeModelsModal(); });

  $modalSearch.addEventListener('input', () => {
    const q = $modalSearch.value;
    if (q) {
      activeCategory = 'All';
      document.querySelectorAll('.modal-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === 'All'));
    }
    renderModelList(q);
  });

  $pullCustomBtn.addEventListener('click', async () => {
    const name = $customInput.value.trim();
    if (!name) return;
    $pullCustomBtn.disabled = true;
    $pullCustomBtn.textContent = 'Pulling…';
    await doCustomPull(name);
    $customInput.value = '';
    $pullCustomBtn.disabled = false;
    $pullCustomBtn.textContent = 'Pull';
  });

  $customInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') $pullCustomBtn.click();
  });

  // ── Delete confirmation (shared by any model row) ──────────────────────────

  const $deleteOverlay = document.getElementById('delete-modal-overlay');
  const $delModelName  = document.getElementById('del-model-name');
  const $delCancelBtn  = document.getElementById('del-cancel-btn');
  const $delConfirmBtn = document.getElementById('del-confirm-btn');
  let _pendingDeleteModel = null;

  function openDeleteModal(modelName) {
    _pendingDeleteModel = modelName;
    $delModelName.textContent = modelName;
    $deleteOverlay.classList.add('open');
  }
  function closeDeleteModal() {
    $deleteOverlay.classList.remove('open');
    _pendingDeleteModel = null;
  }
  async function confirmDelete() {
    const model = _pendingDeleteModel;
    if (!model) return;
    closeDeleteModal();
    showToast(`Deleting ${model}…`);
    try {
      await deleteModel(baseUrl, model);
      showToast(`✅ ${model} deleted`);
      await loadModels();
    } catch (e) {
      showToast(`❌ Delete failed: ${e.message}`);
    }
  }

  $delCancelBtn.addEventListener('click', closeDeleteModal);
  $delConfirmBtn.addEventListener('click', confirmDelete);
  $deleteOverlay.addEventListener('click', e => { if (e.target === $deleteOverlay) closeDeleteModal(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDeleteModal(); closeModelsModal(); }
  });

  return { renderInstalledModelsList };
}
