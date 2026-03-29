let sessions = [];
let selectedIndex = 0;
let searchQuery = '';
let pendingSessionName = null; // @이름 입력 후 대기 상태

// 터미널 모드 상태
let termMode = false;
const terms = new Map(); // key → { term, fitAddon, session, wrapper }
let activeTermKey = null;

// 설정
let settingsOpen = false;
let appSettings = { launchMode: 'inapp' };

const searchEl = document.getElementById('search');
const listEl = document.getElementById('sessions-list');
const enterHint = document.getElementById('enter-hint');
const sessionChip = document.getElementById('session-chip');
const sessionChipName = document.getElementById('session-chip-name');
const settingsModal = document.getElementById('settings-modal');
const launchModeToggle = document.getElementById('launch-mode-toggle');

// 설정 로드
window.cc.getSettings().then(s => {
  appSettings = s;
  applySettingsToggle();
});

// 앱 내 세션 시작 응답 → 터미널 모드 진입
window.cc.onLaunchSessionInApp((session) => {
  enterTerminalMode(session);
});

// blur 처리: 런처 모드일 때만 숨김
window.cc.onCheckTermModeForBlur(() => {
  if (!termMode) {
    window.cc.blurHideIfLauncher();
  }
});

// 세션 업데이트 수신 — 데이터 변경 시만 리렌더
window.cc.onSessionsUpdate((data) => {
  const changed = JSON.stringify(data) !== JSON.stringify(sessions);
  sessions = data;
  if (changed) renderSessions();
});

// 창이 열릴 때 초기화
window.cc.onWindowShown(() => {
  resetState();
  setTimeout(() => searchEl.focus(), 50);
});

// PTY 이벤트 수신
window.cc.onPtyHistory(({ key, data }) => {
  terms.get(key)?.term.write(data);
});

window.cc.onPtyData(({ key, data }) => {
  terms.get(key)?.term.write(data);
});

window.cc.onPtyExit((key) => {
  const t = terms.get(key);
  if (t) {
    t.term.write('\r\n\x1b[90m[세션 종료]\x1b[0m\r\n');
  }
});

window.cc.onPtyReady((key) => {
  const t = terms.get(key);
  if (t) {
    setTimeout(() => {
      t.fitAddon.fit();
      window.cc.ptyResize(key, t.term.cols, t.term.rows);
    }, 100);
  }
});

window.cc.onPtyError((msg) => {
  console.error('PTY 오류:', msg);
});

function resetState() {
  closeSettings();
  searchEl.value = '';
  searchQuery = '';
  selectedIndex = 0;
  pendingSessionName = null;
  sessionChip.classList.add('hidden');
  sessionChipName.textContent = '';
  updateHint();
  renderSessions();
}

// 입력 이벤트
searchEl.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  selectedIndex = 0;
  updateHint();
  renderSessions();
});

function updateHint() {
  if (pendingSessionName) {
    enterHint.classList.remove('hidden');
    enterHint.innerHTML = `<span class="kbd">↵</span> 세션 시작`;
    return;
  }
  const isAt = searchQuery.startsWith('@') && searchQuery.trim().length > 1;
  if (isAt) {
    enterHint.classList.remove('hidden');
    enterHint.innerHTML = `<span class="kbd">↵</span> 이름 확정`;
  } else if (searchQuery.trim()) {
    enterHint.classList.remove('hidden');
    const filtered = getFiltered();
    const selected = filtered[selectedIndex];
    if (selected) {
      enterHint.innerHTML = `<span class="kbd">⌘↵</span> <span style="color:var(--accent)">${escapeHtml(selected.name)}</span>으로 전송`;
    } else {
      enterHint.innerHTML = `<span class="kbd">↵</span> 새 세션`;
    }
  } else {
    enterHint.classList.add('hidden');
  }
}

// 선택만 바꿀 때 — DOM 재생성 없이 클래스만 교체
function updateSelection(newIndex) {
  const items = listEl.querySelectorAll('.session-item');
  if (!items.length) return;
  items[selectedIndex]?.classList.remove('selected');
  selectedIndex = Math.max(0, Math.min(newIndex, items.length - 1));
  items[selectedIndex]?.classList.add('selected');
  items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}

// 좌측/우측 방향키 연속 2회 감지
let lastLeftArrowTime = 0;
let lastRightArrowTime = 0;

// 키보드 네비게이션
document.addEventListener('keydown', (e) => {
  // Cmd+, → 설정 (모든 모드에서)
  if (e.metaKey && e.key === ',') {
    e.preventDefault();
    settingsOpen ? closeSettings() : openSettings();
    return;
  }

  // Esc → 설정 닫기 (최우선)
  if (e.key === 'Escape' && settingsOpen) {
    e.preventDefault();
    closeSettings();
    return;
  }

  // 터미널 모드 단축키
  if (termMode) {
    // Cmd+Opt+← : 이전 탭 (처음에서 → 마지막으로)
    if (e.metaKey && e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      const keys = [...terms.keys()];
      const idx = keys.indexOf(activeTermKey);
      activateTab(keys[(idx - 1 + keys.length) % keys.length]);
      return;
    }
    // Cmd+Opt+→ : 다음 탭 (마지막에서 → 처음으로)
    if (e.metaKey && e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      const keys = [...terms.keys()];
      const idx = keys.indexOf(activeTermKey);
      activateTab(keys[(idx + 1) % keys.length]);
      return;
    }
    // 좌측 방향키 2회 → 런처로 복귀
    if (e.key === 'ArrowLeft') {
      const now = Date.now();
      if (now - lastLeftArrowTime < 400) {
        exitTerminalMode();
        lastLeftArrowTime = 0;
      } else {
        lastLeftArrowTime = now;
      }
    }
    return;
  }

  const filtered = getFiltered();

  switch (e.key) {
    case 'Escape':
      if (pendingSessionName) resetState();
      else window.cc.hide();
      break;

    case 'Backspace':
      if (!searchQuery && pendingSessionName) {
        pendingSessionName = null;
        sessionChip.classList.add('hidden');
        updateHint();
        renderSessions();
      }
      break;

    case 'ArrowDown':
      e.preventDefault();
      updateSelection(selectedIndex + 1);
      break;

    case 'ArrowUp':
      e.preventDefault();
      updateSelection(selectedIndex - 1);
      break;

    case 'ArrowRight':
      if (!searchQuery) {
        // 빈 입력창: 2회 연속(400ms)으로 터미널 진입
        e.preventDefault();
        const nowR = Date.now();
        if (nowR - lastRightArrowTime < 400) {
          handleEnter(filtered);
          lastRightArrowTime = 0;
        } else {
          lastRightArrowTime = nowR;
        }
      } else if (searchQuery.startsWith('@') && filtered[selectedIndex]) {
        // @필터 상태에서 세션 선택 후 → 바로 터미널 진입
        e.preventDefault();
        enterTerminalMode(filtered[selectedIndex]);
      }
      break;

    case 'Enter':
      e.preventDefault();
      if (e.metaKey) {
        if (selectedIndex >= 0 && filtered[selectedIndex] && searchQuery.trim()) {
          window.cc.sendToSession(filtered[selectedIndex], searchQuery.trim());
        }
      } else {
        handleEnter(filtered);
      }
      break;
  }
});

function handleEnter(filtered) {
  // 단계 1: @이름 입력 → 세션 이름 확정
  if (!pendingSessionName && searchQuery.startsWith('@')) {
    const name = searchQuery.slice(1).trim();
    if (!name) return;
    pendingSessionName = name;
    sessionChipName.textContent = name;
    sessionChip.classList.remove('hidden');
    searchEl.value = '';
    searchQuery = '';
    updateHint();
    renderSessions();
    return;
  }

  // 단계 2: 세션 이름 확정 상태 + 메시지 입력 → 새 세션 시작
  if (pendingSessionName) {
    window.cc.launch(pendingSessionName, searchQuery.trim(), appSettings.launchMode);
    return;
  }

  // 일반: 세션 선택 or 텍스트로 새 세션
  activateSelected(filtered);
}

function getFiltered() {
  if (pendingSessionName) return [];
  if (searchQuery.startsWith('@')) {
    const q = searchQuery.slice(1).toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.path && s.path.toLowerCase().includes(q))
    );
  }
  if (!searchQuery.trim()) return sessions;
  const q = searchQuery.toLowerCase();
  return sessions.filter(s =>
    s.name.toLowerCase().includes(q) ||
    (s.path && s.path.toLowerCase().includes(q))
  );
}

function renderSessions() {
  const filtered = getFiltered();

  // @이름 입력 중 — 필터된 세션 목록 표시
  if (searchQuery.startsWith('@') && !pendingSessionName) {
    const name = searchQuery.slice(1).trim();
    if (!name) {
      listEl.innerHTML = `<div class="empty-state">@ 뒤에 세션 이름을 입력하세요</div>`;
      return;
    }
    // name 있으면 아래 filtered 렌더링으로 fall through
  }

  // 세션 이름 확정 후 메시지 대기 중
  if (pendingSessionName) {
    listEl.innerHTML = `<div class="empty-state new-session-hint">
      첫 메시지를 입력하고 ↵ 를 누르면 세션이 시작됩니다<br>
      <span style="color:var(--text-muted);font-size:11px">비워두고 ↵ 누르면 빈 세션으로 시작</span>
    </div>`;
    return;
  }

  if (filtered.length === 0) {
    if (searchQuery.startsWith('@') && searchQuery.slice(1).trim()) {
      const name = searchQuery.slice(1).trim();
      listEl.innerHTML = `<div class="empty-state new-session-hint">일치하는 세션 없음 — ↵ 눌러서 <strong>"${escapeHtml(name)}"</strong> 새 세션 시작</div>`;
    } else {
      listEl.innerHTML = searchQuery.trim()
        ? `<div class="empty-state">일치하는 세션 없음 — <strong>@이름</strong> 으로 새 세션 시작</div>`
        : `<div class="empty-state">실행 중인 Claude 세션 없음</div>`;
    }
    return;
  }

  listEl.innerHTML = filtered.map((s, i) => {
    const statusLabel = {
      thinking: '진행중',
      waiting: '응답대기',
      idle: '완료',
      unknown: '—',
    }[s.status] || '—';

    const pathDisplay = s.path
      ? s.path.replace(/^\/Users\/[^/]+/, '~')
      : '';

    return `
      <div class="session-item ${i === selectedIndex ? 'selected' : ''}" data-index="${i}">
        <div class="status-dot ${s.status}"></div>
        <div class="session-info">
          <div class="session-name">${escapeHtml(s.name)}</div>
          ${pathDisplay ? `<div class="session-path">${escapeHtml(pathDisplay)}</div>` : ''}
          ${s.lastLine ? `<div class="session-preview">${escapeHtml(s.lastLine)}</div>` : ''}
        </div>
        <span class="type-icon">${s.type === 'tmux' ? 'tmux' : 'tty'}</span>
        <span class="status-badge ${s.status}">${statusLabel}</span>
        ${s.tmuxSession ? `<button class="ext-btn" data-tmux="${s.tmuxSession}" title="외부 터미널로 열기">⎋</button>` : ''}
        <button class="kill-btn" data-pid="${s.pid}" data-name="${escapeHtml(s.name)}" data-tmux="${s.tmuxSession || ''}" title="세션 종료">✕</button>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const idx = parseInt(el.dataset.index);
      if (idx !== selectedIndex) updateSelection(idx);
    });
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('kill-btn')) return;
      updateSelection(parseInt(el.dataset.index));
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('kill-btn')) return;
      selectedIndex = parseInt(el.dataset.index);
      activateSelected(getFiltered());
    });
  });

  // 외부 터미널 버튼
  listEl.querySelectorAll('.ext-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tmux = btn.dataset.tmux;
      const session = sessions.find(s => s.tmuxSession === tmux);
      if (session) window.cc.openInTerminal(session);
    });
  });

  // 종료 버튼
  listEl.querySelectorAll('.kill-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      const pid = btn.dataset.pid;
      const tmux = btn.dataset.tmux;
      const confirmed = await window.cc.confirmKill(name);
      if (confirmed) {
        window.cc.killSession({ pid: parseInt(pid), tmuxSession: tmux || null });
      }
    });
  });
}

function activateSelected(filtered) {
  if (searchQuery.trim() && (!filtered.length || selectedIndex < 0)) {
    // 텍스트만 있고 선택 없으면 → 자동 이름으로 새 세션
    const autoName = `cc-${Date.now()}`;
    window.cc.launch(autoName, searchQuery.trim(), appSettings.launchMode);
  } else if (selectedIndex >= 0 && filtered[selectedIndex]) {
    if (searchQuery.trim()) {
      window.cc.sendToSession(filtered[selectedIndex], searchQuery.trim());
    } else {
      // 터미널 모드로 진입 (Enter 또는 더블클릭)
      enterTerminalMode(filtered[selectedIndex]);
    }
  }
  // else: filtered is empty (no sessions loaded yet) — do nothing silently
}

// ── 터미널 모드 ──────────────────────────────────────────────

function enterTerminalMode(session) {
  termMode = true;
  document.getElementById('launcher-view').classList.add('hidden');
  document.getElementById('terminal-view').classList.remove('hidden');
  window.cc.setTerminalMode();
  enterTerminalOpacity();
  openTermTab(session);
}

function exitTerminalMode() {
  termMode = false;
  document.getElementById('terminal-view').classList.add('hidden');
  document.getElementById('launcher-view').classList.remove('hidden');
  window.cc.setLauncherMode();
  enterLauncherOpacity();
  // pty는 종료하지 않고 유지 (다시 터미널 모드 진입 시 재사용)
  setTimeout(() => searchEl.focus(), 100);
}

function openTermTab(session) {
  const key = session.tmuxSession || String(session.pid || session.name);

  // 이미 탭 있으면 활성화
  if (terms.has(key)) {
    activateTab(key);
    window.cc.openPty(session);
    return;
  }

  // 새 xterm 인스턴스
  const container = document.getElementById('term-container');
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
  wrapper.id = `term-wrap-${key}`;
  container.appendChild(wrapper);

  const term = new Terminal({
    theme: {
      background: 'transparent',
      foreground: '#e4e4e7',
      cursor: '#a78bfa',
      selectionBackground: 'rgba(139,92,246,0.3)',
    },
    fontSize: 13,
    fontFamily: '"Menlo", "Monaco", "Apple SD Gothic Neo", "Malgun Gothic", "Courier New", monospace',
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
    copyOnSelect: true,
    rightClickSelectsWord: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(wrapper);
  term.onData(data => window.cc.ptyInput(key, data));
  // Cmd+Shift+← → 런처로 복귀 (pty에는 전송 안 함)
  // Cmd+C → 선택 텍스트 있으면 클립보드 복사, 없으면 Ctrl+C 시그널
  term.onKey(({ key: k, domEvent: ev }) => {
    if (ev.metaKey && ev.key === ',') {
      ev.preventDefault();
      // document.keydown 버블링에서 toggleSettings 처리하므로 여기선 preventDefault만
      return;
    }
    if (ev.metaKey && ev.shiftKey && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      exitTerminalMode();
      return;
    }
    if (ev.metaKey && ev.key === 'c') {
      const sel = term.getSelection();
      if (sel) {
        ev.preventDefault();
        window.cc.writeClipboard(sel);
        return;
      }
    }
  });

  terms.set(key, { term, fitAddon, session, wrapper });
  renderTabs();
  activateTab(key);
  window.cc.openPty(session);
}

function activateTab(key) {
  activeTermKey = key;
  terms.forEach((t, k) => {
    t.wrapper.style.display = k === key ? 'block' : 'none';
  });
  renderTabs();
  setTimeout(() => {
    const t = terms.get(key);
    if (t) {
      t.fitAddon.fit();
      window.cc.ptyResize(key, t.term.cols, t.term.rows);
      t.term.focus();
    }
  }, 50);
}

function renderTabs() {
  const tabsEl = document.getElementById('term-tabs');
  tabsEl.innerHTML = [...terms.entries()].map(([key, { session }]) => `
    <div class="term-tab ${key === activeTermKey ? 'active' : ''}" data-key="${key}">
      <div class="status-dot ${session.status || 'idle'}"></div>
      <span>${escapeHtml(session.name)}</span>
      <span class="tab-close" data-close="${key}">✕</span>
    </div>
  `).join('');

  tabsEl.querySelectorAll('.term-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      const closeKey = e.target.dataset.close;
      if (closeKey) {
        e.stopPropagation();
        closeTab(closeKey);
      } else {
        activateTab(el.dataset.key);
      }
    });
  });
}

function closeTab(key) {
  window.cc.closePty(key);
  const t = terms.get(key);
  if (t) {
    t.term.dispose();
    t.wrapper.remove();
    terms.delete(key);
  }
  if (activeTermKey === key) {
    const remaining = [...terms.keys()];
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      exitTerminalMode();
    }
  } else {
    renderTabs();
  }
}

// 뒤로가기 버튼
document.getElementById('btn-back').addEventListener('click', exitTerminalMode);

// 새 탭 버튼: 런처로 돌아가서 세션 선택
document.getElementById('btn-new-tab').addEventListener('click', () => {
  exitTerminalMode();
});

// 창 리사이즈 시 active term fit
window.addEventListener('resize', () => {
  if (termMode && activeTermKey) {
    const t = terms.get(activeTermKey);
    if (t) {
      t.fitAddon.fit();
      window.cc.ptyResize(activeTermKey, t.term.cols, t.term.rows);
    }
  }
});

// ── opacity 슬라이더 (런처/터미널 모드별 독립 저장) ──────────────
let launcherOpacityVal = 82;
let terminalOpacityVal = 92; // 터미널은 기본 더 밝게

function applyOpacity(val) {
  const alpha = val / 100;
  document.documentElement.style.setProperty('--bg', `rgba(24, 24, 27, ${alpha})`);
  // win.setOpacity()는 backdrop-filter blur를 깨뜨리므로 사용 안 함
  // CSS --bg 변수로만 투명도 조절
}

function enterTerminalOpacity() {
  document.getElementById('opacity-slider').value = terminalOpacityVal;
  applyOpacity(terminalOpacityVal);
}

function enterLauncherOpacity() {
  document.getElementById('opacity-slider-launcher').value = launcherOpacityVal;
  applyOpacity(launcherOpacityVal);
}

document.getElementById('opacity-slider').addEventListener('input', (e) => {
  terminalOpacityVal = parseInt(e.target.value);
  applyOpacity(terminalOpacityVal);
});

document.getElementById('opacity-slider-launcher').addEventListener('input', (e) => {
  launcherOpacityVal = parseInt(e.target.value);
  applyOpacity(launcherOpacityVal);
});

// ── 설정 모달 ──────────────────────────────────────────────

function applySettingsToggle() {
  launchModeToggle.querySelectorAll('.settings-toggle').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === appSettings.launchMode);
  });
}

function openSettings() {
  if (settingsOpen) return;
  settingsOpen = true;
  settingsModal.classList.remove('hidden');
  applySettingsToggle();
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  settingsModal.classList.add('hidden');
  if (!termMode) setTimeout(() => searchEl.focus(), 50);
}

document.getElementById('settings-close').addEventListener('click', closeSettings);

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

launchModeToggle.addEventListener('click', async (e) => {
  const btn = e.target.closest('.settings-toggle');
  if (!btn) return;
  const value = btn.dataset.value;
  if (value === appSettings.launchMode) return;
  appSettings = await window.cc.setSetting('launchMode', value);
  applySettingsToggle();
});

// ── 유틸 ──────────────────────────────────────────────────


function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
