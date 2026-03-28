let sessions = [];
let selectedIndex = 0;
let searchQuery = '';
let pendingSessionName = null; // @이름 입력 후 대기 상태

const searchEl = document.getElementById('search');
const listEl = document.getElementById('sessions-list');
const enterHint = document.getElementById('enter-hint');
const sessionChip = document.getElementById('session-chip');
const sessionChipName = document.getElementById('session-chip-name');

// 세션 업데이트 수신
window.cc.onSessionsUpdate((data) => {
  sessions = data;
  renderSessions();
});

// 창이 열릴 때 초기화
window.cc.onWindowShown(() => {
  resetState();
  setTimeout(() => searchEl.focus(), 50);
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
    enterHint.innerHTML = `<span class="kbd">↵</span> 새 세션`;
  } else {
    enterHint.classList.add('hidden');
  }
}

// 키보드 네비게이션
document.addEventListener('keydown', (e) => {
  const filtered = getFiltered();

  switch (e.key) {
    case 'Escape':
      if (pendingSessionName) {
        // @이름 입력 취소
        resetState();
      } else {
        window.cc.hide();
      }
      break;

    case 'Backspace':
      // 입력창 비어있고 세션 이름 대기 중이면 → 이름 취소
      if (!searchQuery && pendingSessionName) {
        pendingSessionName = null;
        sessionChip.classList.add('hidden');
        updateHint();
        renderSessions();
      }
      break;

    case 'ArrowDown':
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      renderSessions();
      scrollToSelected();
      break;

    case 'ArrowUp':
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderSessions();
      scrollToSelected();
      break;

    case 'Enter':
      e.preventDefault();
      if (e.metaKey) {
        // ⌘+Enter: 선택된 세션에 메시지 전송
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
  // @이름 입력 중이거나 세션 대기 중이면 목록 숨김
  if (pendingSessionName || searchQuery.startsWith('@')) return [];
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
        </div>
        <span class="type-icon">${s.type === 'tmux' ? 'tmux' : 'tty'}</span>
        <span class="status-badge ${s.status}">${statusLabel}</span>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      selectedIndex = parseInt(el.dataset.index);
      renderSessions();
    });

    el.addEventListener('click', () => {
      selectedIndex = parseInt(el.dataset.index);
      renderSessions();
    });

    el.addEventListener('dblclick', () => {
      selectedIndex = parseInt(el.dataset.index);
      activateSelected(filtered);
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
      window.cc.focusSession(filtered[selectedIndex]);
    }
  }
}

function scrollToSelected() {
  const items = listEl.querySelectorAll('.session-item');
  if (items[selectedIndex]) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
