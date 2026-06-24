// @ts-nocheck
/* ADO Things — webview SPA (vanilla, no framework).
   Pure view: sends INTENTS, renders STATE. No DB, no network here. */
(function () {
    const vscode = acquireVsCodeApi();

    let currentView = 'today';

    const els = {
        title: document.getElementById('view-title'),
        subtitle: document.getElementById('view-subtitle'),
        banner: document.getElementById('sync-banner'),
        quickInput: document.getElementById('quick-add-input'),
        list: document.getElementById('list'),
        empty: document.getElementById('empty-state'),
        detail: document.getElementById('detail-pane'),
        detailTitle: document.getElementById('detail-title'),
        detailSubtitle: document.getElementById('detail-subtitle'),
        detailDescription: document.getElementById('detail-description'),
        detailFields: document.getElementById('detail-fields'),
        detailNotesWrap: document.getElementById('detail-notes-wrap'),
        detailNotes: document.getElementById('detail-notes'),
        detailClose: document.getElementById('detail-close'),
        detailOpenAdo: document.getElementById('detail-open-ado')
    };

    const EMPTY_MESSAGES = {
        inbox: 'Your Inbox is clear.',
        today: 'Nothing for Today.',
        upcoming: 'Nothing scheduled.',
        anytime: 'Nothing here yet.',
        someday: 'Someday, maybe.',
        logbook: 'No completed items yet.'
    };

    function send(msg) {
        vscode.postMessage(msg);
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function isOverdue(iso) {
        if (!iso) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return new Date(iso + 'T00:00:00') < today;
    }

    function renderTask(task) {
        const row = el('div', 'task-row' + (task.completed ? ' done' : ''));
        row.dataset.uuid = task.uuid;
        row.setAttribute('role', 'listitem');
        row.setAttribute('tabindex', '-1');
        row.setAttribute('aria-label', task.title + (task.completed ? ' (completed)' : ''));

        // Circular checkbox
        const checkbox = el('div', 'checkbox' + (task.completed ? ' checked' : ''));
        checkbox.setAttribute('role', 'checkbox');
        checkbox.setAttribute('aria-checked', String(task.completed));
        checkbox.title = task.completed ? 'Mark as not done' : 'Complete';
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            if (task.completed) {
                send({ type: 'uncompleteTask', uuid: task.uuid });
            } else {
                // Satisfying completion: animate, then tell the host.
                checkbox.classList.add('checked');
                row.classList.add('completing');
                setTimeout(() => send({ type: 'completeTask', uuid: task.uuid }), 240);
            }
        });
        row.appendChild(checkbox);

        // Title + metadata
        const main = el('div', 'task-main');
        const title = el('div', 'task-title', task.title);
        title.title = 'Open details';
        title.addEventListener('click', (e) => {
            e.stopPropagation();
            send({ type: 'openTask', uuid: task.uuid });
        });
        main.appendChild(title);

        const meta = el('div', 'task-meta');
        if (task.type) {
            meta.appendChild(el('span', 'type-glyph', task.type));
        }
        if (task.state) {
            meta.appendChild(el('span', 'chip state', task.state));
        }
        if (task.whenDate) {
            meta.appendChild(el('span', 'chip date', '↪ ' + task.whenDate));
        }
        if (task.deadline) {
            const chip = el('span', 'chip date' + (isOverdue(task.deadline) ? ' overdue' : ''), '⚑ ' + task.deadline);
            meta.appendChild(chip);
        }
        if (task.adoId) {
            const ado = el('span', 'chip ado', '#' + task.adoId);
            ado.title = 'Open in browser';
            ado.addEventListener('click', (e) => {
                e.stopPropagation();
                send({ type: 'openWorkItem', adoId: task.adoId });
            });
            meta.appendChild(ado);
        }
        for (const tag of task.tags || []) {
            meta.appendChild(el('span', 'chip', tag));
        }
        if (meta.childNodes.length > 0) {
            main.appendChild(meta);
        }
        row.appendChild(main);

        // Trailing hover actions
        const actions = el('div', 'task-actions');
        if (!task.completed) {
            const star = el('button', 'action-btn', task.today ? '★' : '☆');
            star.title = 'Move to Today';
            star.addEventListener('click', (e) => { e.stopPropagation(); send({ type: 'moveToToday', uuid: task.uuid }); });
            actions.appendChild(star);

            if (task.adoId) {
                const state = el('button', 'action-btn', '⇄');
                state.title = 'Change state';
                state.addEventListener('click', (e) => { e.stopPropagation(); send({ type: 'changeState', uuid: task.uuid }); });
                actions.appendChild(state);
            } else {
                // Local-only task: offer to push it to Azure DevOps.
                const push = el('button', 'action-btn', '↑ADO');
                push.title = 'Push to Azure DevOps (create work item)';
                push.addEventListener('click', (e) => { e.stopPropagation(); send({ type: 'pushToAdo', uuid: task.uuid }); });
                actions.appendChild(push);
            }
        }
        row.appendChild(actions);

        return row;
    }

    function renderSnapshot(snapshot) {
        currentView = snapshot.view;
        els.title.textContent = snapshot.title;
        els.subtitle.textContent = snapshot.subtitle || '';

        els.list.innerHTML = '';
        els.list.setAttribute('role', 'list');
        let total = 0;
        for (const group of snapshot.groups) {
            if (group.header) {
                els.list.appendChild(el('div', 'group-header', group.header));
            }
            for (const task of group.tasks) {
                els.list.appendChild(renderTask(task));
                total++;
            }
        }

        if (total === 0) {
            els.empty.textContent = EMPTY_MESSAGES[snapshot.view] || 'Nothing here.';
            els.empty.classList.remove('hidden');
        } else {
            els.empty.classList.add('hidden');
        }

        // Quick-add is hidden in the read-mostly Logbook.
        document.getElementById('quick-add').style.display = snapshot.view === 'logbook' ? 'none' : '';
    }

    // Strip HTML tags to plain text (safe rendering of ADO rich text under CSP).
    function htmlToText(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    function renderDetail(detail) {
        els.detailTitle.textContent = (detail.adoId ? '#' + detail.adoId + ' ' : '') + detail.title;
        els.detailSubtitle.textContent = [detail.type, detail.state].filter(Boolean).join(' · ');

        // ADO description (rendered as safe plain text for Slice 1).
        if (detail.description) {
            els.detailDescription.textContent = htmlToText(detail.description);
            els.detailDescription.classList.remove('hidden');
        } else {
            els.detailDescription.classList.add('hidden');
        }

        // Metadata fields.
        els.detailFields.innerHTML = '';
        for (const field of detail.fields) {
            els.detailFields.appendChild(el('dt', null, field.label));
            els.detailFields.appendChild(renderFieldValue(detail, field));
        }

        // Local notes.
        if (detail.notes) {
            els.detailNotes.textContent = detail.notes;
            els.detailNotesWrap.classList.remove('hidden');
        } else {
            els.detailNotesWrap.classList.add('hidden');
        }

        // Open-in-ADO button.
        if (detail.adoId) {
            els.detailOpenAdo.classList.remove('hidden');
            els.detailOpenAdo.onclick = () => send({ type: 'openWorkItem', adoId: detail.adoId });
        } else {
            els.detailOpenAdo.classList.add('hidden');
        }

        els.detail.classList.remove('hidden');
    }

    function closeDetail() {
        els.detail.classList.add('hidden');
        send({ type: 'closeTask' });
    }

    // Render a detail field as a static value or an editable control.
    function renderFieldValue(detail, field) {
        const dd = el('dd');

        // Fields with a discrete action (e.g. State -> transition picker).
        if (field.action === 'changeState') {
            const wrap = el('div', 'identity-edit');
            wrap.appendChild(el('span', null, field.value || '—'));
            const btn = el('button', 'action-btn assign-me', 'Change…');
            btn.title = 'Change state';
            btn.addEventListener('click', () => send({ type: 'changeState', uuid: detail.uuid }));
            wrap.appendChild(btn);
            dd.appendChild(wrap);
            return dd;
        }

        if (!field.editable) {
            dd.textContent = field.value || '—';
            return dd;
        }

        const uuid = detail.uuid;
        const commit = (value) => {
            if (field.source === 'local') {
                if (field.key === 'local.when') send({ type: 'setWhen', uuid, date: value || undefined });
                else if (field.key === 'local.deadline') send({ type: 'setDeadline', uuid, date: value || undefined });
            } else {
                send({ type: 'updateField', uuid, ref: field.ref, value });
            }
        };

        let input;
        if (field.control === 'enum') {
            input = document.createElement('select');
            input.className = 'detail-input';
            const blank = el('option', null, '—');
            blank.value = '';
            input.appendChild(blank);
            for (const opt of field.options || []) {
                const o = el('option', null, opt);
                o.value = opt;
                input.appendChild(o);
            }
            input.value = field.editValue || '';
            input.addEventListener('change', () => commit(input.value));
        } else if (field.control === 'identity') {
            // Editable assignee: text entry (email/UPN) + "Assign to me".
            const wrap = el('div', 'identity-edit');
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'detail-input';
            input.placeholder = 'name@company.com';
            input.value = field.editValue || '';
            input.addEventListener('change', () => commit(input.value));
            wrap.appendChild(input);
            if (detail.currentUser) {
                const me = el('button', 'action-btn assign-me', 'Assign to me');
                me.title = 'Assign to ' + detail.currentUser;
                me.addEventListener('click', () => {
                    input.value = detail.currentUser;
                    commit(detail.currentUser);
                });
                wrap.appendChild(me);
            }
            dd.appendChild(wrap);
            return dd;
        } else if (field.control === 'date') {
            input = document.createElement('input');
            input.type = 'date';
            input.className = 'detail-input';
            input.value = field.editValue || '';
            input.addEventListener('change', () => commit(input.value));
        } else if (field.control === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.className = 'detail-input';
            input.value = field.editValue || '';
            input.addEventListener('change', () => commit(input.value === '' ? '' : Number(input.value)));
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'detail-input';
            input.value = field.editValue || '';
            input.addEventListener('change', () => commit(input.value));
        }
        dd.appendChild(input);
        return dd;
    }

    function renderSyncStatus(status) {
        if (status.phase === 'offline') {
            els.banner.textContent = 'Offline — showing cached data';
            els.banner.className = 'offline';
        } else if (status.phase === 'syncing') {
            els.banner.textContent = 'Syncing…';
            els.banner.className = '';
        } else if (status.pendingCount > 0) {
            els.banner.textContent = status.pendingCount + ' change(s) pending sync';
            els.banner.className = '';
        } else {
            els.banner.className = 'hidden';
        }
    }

    // Quick capture: Enter creates a task in the current list's bucket.
    els.quickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const title = els.quickInput.value.trim();
            if (title) {
                send({ type: 'createTask', title, view: currentView });
                els.quickInput.value = '';
            }
        }
    });

    // Keyboard navigation across rows: ArrowUp/Down to move, Space/Enter to
    // toggle completion, 't' to flag for Today, 'o' to open the work item.
    function rows() {
        return Array.prototype.slice.call(els.list.querySelectorAll('.task-row'));
    }
    function focusRow(idx) {
        const all = rows();
        if (all.length === 0) return;
        const clamped = Math.max(0, Math.min(idx, all.length - 1));
        all[clamped].focus();
    }
    document.addEventListener('keydown', (e) => {
        if (document.activeElement === els.quickInput) return;
        const all = rows();
        const current = all.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusRow(current < 0 ? 0 : current + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusRow(current < 0 ? 0 : current - 1);
        } else if ((e.key === ' ' || e.key === 'Enter') && current >= 0) {
            e.preventDefault();
            const cb = all[current].querySelector('.checkbox');
            if (cb) cb.click();
        } else if (e.key.toLowerCase() === 't' && current >= 0) {
            send({ type: 'moveToToday', uuid: all[current].dataset.uuid });
        }
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'snapshot':
                renderSnapshot(msg.snapshot);
                break;
            case 'syncStatus':
                renderSyncStatus(msg.status);
                break;
            case 'taskDetail':
                renderDetail(msg.detail);
                break;
        }
    });

    els.detailClose.addEventListener('click', closeDetail);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !els.detail.classList.contains('hidden')) {
            closeDetail();
        }
    });

    send({ type: 'ready' });
})();
