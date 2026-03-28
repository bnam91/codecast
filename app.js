let sessions = [];
let selectedIndex = 0;
let searchQuery = '';
let pendingSessionName = null; // @이름 입력 후 대기 상태

// 터미널 모드 상태
let termMode = false;
const terms = new Map(); // key → { term, fitAddon, session, wrapper }
let activeTermKey = null;

const searchEl = document.getElementById('search');
const listEl = document.getElementById('sessions-list');
const enterHint = document.getElementById('enter-hint');
const sessionChip = document.getElementById('session-chip');
const sessionChipName = document.getElementById('session-chip-name');

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

// 좌측 방향키 연속 2회 감지
let lastLeftArrowTime = 0;

// 키보드 네비게이션
document.addEventListener('keydown', (e) => {
  // 터미널 모드에서는 좌측 방향키 2회만 처리
  if (termMode) {
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
      // 입력창이 비어있을 때만 → Enter와 동일
      if (!searchQuery) {
        e.preventDefault();
        handleEnter(filtered);
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
    window.cc.launch(pendingSessionName, searchQuery.trim());
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

  // @이름 입력 중
  if (searchQuery.startsWith('@') && !pendingSessionName) {
    const name = searchQuery.slice(1).trim();
    listEl.innerHTML = name
      ? `<div class="empty-state new-session-hint">↵ 눌러서 <strong>"${escapeHtml(name)}"</strong> 이름으로 세션 준비</div>`
      : `<div class="empty-state">@ 뒤에 세션 이름을 입력하세요</div>`;
    return;
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
    listEl.innerHTML = searchQuery.trim()
      ? `<div class="empty-state">일치하는 세션 없음 — <strong>@이름</strong> 으로 새 세션 시작</div>`
      : `<div class="empty-state">실행 중인 Claude 세션 없음</div>`;
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

  // 종료 버튼
  listEl.querySelectorAll('.kill-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      const pid = btn.dataset.pid;
      const tmux = btn.dataset.tmux;
      if (confirm(`"${name}" 세션을 종료하시겠습니까?`)) {
        window.cc.killSession({ pid: parseInt(pid), tmuxSession: tmux || null });
      }
    });
  });
}

function activateSelected(filtered) {
  if (searchQuery.trim() && (!filtered.length || selectedIndex < 0)) {
    // 텍스트만 있고 선택 없으면 → 자동 이름으로 새 세션
    const autoName = `cc-${Date.now()}`;
    window.cc.launch(autoName, searchQuery.trim());
  } else if (selectedIndex >= 0 && filtered[selectedIndex]) {
    if (searchQuery.trim()) {
      window.cc.sendToSession(filtered[selectedIndex], searchQuery.trim());
    } else {
      // 터미널 모드로 진입 (Enter 또는 더블클릭)
      enterTerminalMode(filtered[selectedIndex]);
    }
  }
}

// ── 터미널 모드 ──────────────────────────────────────────────

function enterTerminalMode(session) {
  termMode = true;
  document.getElementById('launcher-view').classList.add('hidden');
  document.getElementById('terminal-view').classList.remove('hidden');
  window.cc.setTerminalMode();
  openTermTab(session);
}

function exitTerminalMode() {
  termMode = false;
  document.getElementById('terminal-view').classList.add('hidden');
  document.getElementById('launcher-view').classList.remove('hidden');
  window.cc.setLauncherMode();
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
      background: '#0d0d0f',
      foreground: '#e4e4e7',
      cursor: '#a78bfa',
      selectionBackground: 'rgba(139,92,246,0.3)',
    },
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(wrapper);
  term.onData(data => window.cc.ptyInput(key, data));
  // Cmd+Shift+← → 런처로 복귀 (pty에는 전송 안 함)
  term.onKey(({ key: k, domEvent: ev }) => {
    if (ev.metaKey && ev.shiftKey && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      exitTerminalMode();
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

// ── 유틸 ──────────────────────────────────────────────────

function scrollToSelected() {
  const items = listEl.querySelectorAll('.session-item');
  if (items[selectedIndex]) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
