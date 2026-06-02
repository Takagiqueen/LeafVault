(function (window) {
    'use strict';

    const AUTH_VIEWS = {
        login: { formId: 'loginForm', subtitle: '把每一天，安全收藏' },
        register: { formId: 'registerForm', subtitle: '创建你的私密生活库' },
        reset: { formId: 'resetForm', subtitle: '找回安全入口' },
    };

    const state = {
        showToast: () => {},
        initApp: () => {},
        loginOverlayEl: null,
        onLogout: () => {},
        deploymentStatus: null,
        registrationMode: 'open',
    };

    function toast(message, isError = false) {
        state.showToast(message, isError);
    }

    function getLoginOverlay() {
        return state.loginOverlayEl || document.getElementById('loginOverlay');
    }

    async function fetchDeploymentStatus() {
        try {
            const res = await fetch('/api/deployment/status', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!res.ok) return null;
            const json = await res.json();
            return json?.status === 'success' ? json : null;
        } catch (_) {
            return null;
        }
    }

    function applyDeploymentStatus(status) {
        state.deploymentStatus = status || null;
        state.registrationMode = status?.registration_mode || 'open';

        const inviteWrap = document.getElementById('registrationInviteWrap');
        const inviteInput = document.getElementById('registrationInviteCode');
        const closedHint = document.getElementById('registrationClosedHint');
        const registerSubmit = document.querySelector('#registerForm button[type="submit"]');
        const registerLinks = document.querySelectorAll('[data-auth-view="register"]');
        const isInvite = state.registrationMode === 'invite';
        const isClosed = state.registrationMode === 'closed';

        inviteWrap?.classList.toggle('hidden', !isInvite);
        if (inviteInput) {
            inviteInput.required = isInvite;
            if (!isInvite) inviteInput.value = '';
        }
        closedHint?.classList.toggle('hidden', !isClosed);
        if (registerSubmit) {
            registerSubmit.disabled = isClosed;
            registerSubmit.classList.toggle('opacity-60', isClosed);
            registerSubmit.classList.toggle('cursor-not-allowed', isClosed);
        }
        registerLinks.forEach((link) => {
            link.classList.toggle('opacity-50', isClosed);
            link.classList.toggle('pointer-events-none', isClosed);
            link.setAttribute('aria-disabled', isClosed ? 'true' : 'false');
        });
    }

    function updateDemoModeBanner() {
        const banner = document.getElementById('demoModeBanner');
        if (!banner) return;
        const isDemo = Boolean(window.LeafVaultSession?.isDemoMode?.());
        banner.classList.toggle('hidden', !isDemo);
    }

    async function refreshDeploymentStatus() {
        const status = await fetchDeploymentStatus();
        if (status) applyDeploymentStatus(status);
        return status;
    }

    function toggleAuth(mode) {
        if (mode === 'register' && state.registrationMode === 'closed') {
            toast('当前部署暂未开放新用户注册，已有账号可以继续登录。', true);
            mode = 'login';
        }
        Object.values(AUTH_VIEWS).forEach(({ formId }) => {
            document.getElementById(formId)?.classList.add('hidden');
        });

        const view = AUTH_VIEWS[mode] || AUTH_VIEWS.login;
        document.getElementById(view.formId)?.classList.remove('hidden');
        const subtitle = document.getElementById('authSubtitle');
        if (subtitle) subtitle.innerText = view.subtitle;

        // 仅同步视觉态：保持原 data-auth-view 切换逻辑不变。
        document.querySelectorAll('.auth-tab[data-auth-view]').forEach((tab) => {
            const isActive = tab.dataset.authView === mode;
            tab.classList.toggle('is-active', isActive);
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
    }

    async function sendCode(inputId, actionType, btn) {
        const email = document.getElementById(inputId)?.value;
        if (!email) return toast('请先输入邮箱', true);

        const fd = new FormData();
        fd.append('email', email);
        fd.append('action_type', actionType);

        btn.disabled = true;
        const originalText = btn.innerText;
        btn.innerText = '发送中...';
        if (btn.timerId) clearInterval(btn.timerId);

        try {
            const res = await fetch('/api/send_code', { method: 'POST', body: fd });
            const json = await res.json();
            if (json.status === 'success') {
                toast(json.message);
                let seconds = 60;
                btn.timerId = setInterval(() => {
                    btn.innerText = `${seconds}s后重试`;
                    seconds -= 1;
                    if (seconds < 0) {
                        clearInterval(btn.timerId);
                        btn.disabled = false;
                        btn.innerText = originalText;
                    }
                }, 1000);
            } else {
                toast(json.message, true);
                btn.disabled = false;
                btn.innerText = originalText;
            }
        } catch (_) {
            toast('网络错误', true);
            btn.disabled = false;
            btn.innerText = originalText;
        }
    }

    const REGISTER_USERNAME_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const REGISTER_USERNAME_ALLOWED_RE = /^[a-zA-Z0-9_\-\u4e00-\u9fff]{2,30}$/;
    const REGISTER_USERNAME_EMAIL_MESSAGE = '用户名不能使用邮箱格式，请填写昵称；邮箱请填写在邮箱栏。';

    function getRegisterUsernameError(value) {
        const username = String(value || '').trim();
        if (!username) return '';
        if (username.includes('@') || REGISTER_USERNAME_EMAIL_RE.test(username)) {
            return REGISTER_USERNAME_EMAIL_MESSAGE;
        }
        if (/\s/.test(username) || !REGISTER_USERNAME_ALLOWED_RE.test(username)) {
            return '用户名格式不正确，只能使用中文、英文、数字、下划线或短横线，长度 2-30 位。';
        }
        return '';
    }

    function updateRegisterUsernameHint(input) {
        const hint = document.getElementById('registerUsernameHint');
        if (!hint || !input) return '';
        const message = getRegisterUsernameError(input.value);
        hint.textContent = message || '用户名用于展示昵称；邮箱请填写在邮箱栏。';
        hint.classList.toggle('hidden', !message);
        input.setAttribute('aria-invalid', message ? 'true' : 'false');
        return message;
    }

    function getFastApiDetailItems(detail) {
        if (Array.isArray(detail)) return detail;
        if (detail && typeof detail === 'object') return [detail];
        if (typeof detail === 'string') return [{ msg: detail }];
        return [];
    }

    function mapRegisterFieldError(field, message, code) {
        const normalizedField = String(field || '').toLowerCase();
        const normalizedCode = String(code || '').toLowerCase();
        const normalizedMessage = String(message || '');
        if (normalizedField === 'username' || normalizedCode.includes('username') || normalizedMessage.includes('用户名')) {
            return '用户名格式不正确，不能使用邮箱格式或特殊符号。';
        }
        if (normalizedField === 'email' || normalizedMessage.includes('邮箱')) {
            return '邮箱格式不正确。';
        }
        if (normalizedField === 'password' || normalizedMessage.includes('密码')) {
            return normalizedMessage || '密码格式不正确，请至少使用 8 位密码。';
        }
        if (normalizedField === 'invite_code' || normalizedCode.includes('invite')) {
            return '邀请码不正确或格式错误。';
        }
        if (normalizedField === 'verification_code' || normalizedField === 'code' || normalizedMessage.includes('验证码')) {
            return '验证码不正确或已过期。';
        }
        return normalizedMessage || '';
    }

    function formatRegisterError(status, body) {
        if (status === 422) {
            const detailItems = getFastApiDetailItems(body?.detail);
            const messages = detailItems
                .map((item) => {
                    const loc = Array.isArray(item?.loc) ? item.loc : [];
                    const field = item?.field || loc[loc.length - 1] || '';
                    return mapRegisterFieldError(field, item?.message || item?.msg || body?.message, item?.code || item?.type);
                })
                .filter(Boolean);
            return messages.length ? Array.from(new Set(messages)).join('；') : '提交内容格式不正确，请检查用户名、邮箱、密码、邀请码和验证码。';
        }
        if (body?.message) {
            if (String(body.message).includes('邀请码')) return '邀请码不正确或格式错误。';
            if (String(body.message).includes('验证码')) return '验证码不正确或已过期。';
            return body.message;
        }
        return '操作失败，请稍后重试。';
    }

    function setupRegisterForm() {
        const form = document.getElementById('registerForm');
        if (!form || form.dataset.authBound === '1') return;
        form.dataset.authBound = '1';
        const usernameInput = form.querySelector('[data-register-username-input], input[name="username"]');
        usernameInput?.addEventListener('input', () => updateRegisterUsernameHint(usernameInput));
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const usernameMessage = updateRegisterUsernameHint(usernameInput);
            if (usernameMessage) {
                toast(usernameMessage, true);
                usernameInput?.focus();
                return;
            }
            if (state.registrationMode === 'closed') {
                toast('当前部署暂未开放新用户注册。', true);
                return;
            }
            if (state.registrationMode === 'invite') {
                const inviteInput = document.getElementById('registrationInviteCode');
                if (!inviteInput?.value?.trim()) {
                    toast('请输入注册邀请码。', true);
                    inviteInput?.focus();
                    return;
                }
            }
            try {
                const res = await fetch('/api/register', {
                    method: 'POST',
                    body: new FormData(event.target),
                    credentials: 'same-origin',
                });
                const json = await res.json();
                if (res.ok && json.status === 'success') {
                    toast(`🎉  ${json.message}`);
                    toggleAuth('login');
                } else {
                    toast(formatRegisterError(res.status, json), true);
                }
            } catch (_) {
                toast('注册失败', true);
            }
        });
    }

    function toggleSettingsResetModal() {
        const modal = document.getElementById('settingsResetModal');
        const content = document.getElementById('settingsResetModalContent');
        if (!modal || !content) return;
        if (modal.classList.contains('hidden')) {
            modal.classList.remove('hidden');
            setTimeout(() => {
                modal.classList.remove('opacity-0');
                content.classList.remove('scale-95');
                document.getElementById('settingsResetEmail')?.focus();
            }, 10);
        } else {
            modal.classList.add('opacity-0');
            content.classList.add('scale-95');
            setTimeout(() => modal.classList.add('hidden'), 300);
        }
    }

    function setupResetForms() {
        document.querySelectorAll('[data-reset-password-form], #resetForm, #settingsResetForm').forEach((form) => {
            if (!form || form.dataset.authBound === '1') return;
            form.dataset.authBound = '1';
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                try {
                    const res = await fetch('/api/reset_password', { method: 'POST', body: new FormData(event.target) });
                    const json = await res.json();
                    if (json.status === 'success') {
                        toast(`✅  ${json.message}`);
                        event.target.reset();
                        // 设置页内重置密码时只关闭弹窗；登录页重置仍回到登录表单。
                        if (event.target.id === 'settingsResetForm') {
                            toggleSettingsResetModal();
                        } else {
                            toggleAuth('login');
                        }
                    } else {
                        toast(json.message, true);
                    }
                } catch (_) {
                    toast('重置密码失败', true);
                }
            });
        });
    }

    function setupLoginForm() {
        const form = document.getElementById('loginForm');
        if (!form || form.dataset.authBound === '1') return;
        form.dataset.authBound = '1';
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const formData = new FormData(event.target);
            const loginPassword = String(formData.get('password') || '');
            try {
                const res = await fetch('/api/login', { method: 'POST', body: formData, credentials: 'same-origin' });
                const json = await res.json();
                if (json.status === 'success') {
                    if (window.LeafVaultSession?.isDemoMode?.()) window.LeafVaultSession.exitDemoMode?.();
                    window.LeafVaultSession.setSessionMode?.('user');
                    window.LeafVaultSession.setAuthMode(json.prefer_cookie ? 'cookie' : 'bearer');
                    window.LeafVaultSession.setStoreTokenInLocalStorage?.(json.store_token_in_localstorage !== false);
                    // 迁移期兼容：setAuthToken 会根据后端策略决定是否落盘；生产 Cookie 优先时默认不写 localStorage。
                    if (json.token && json.localstorage_compat !== false) window.LeafVaultSession.setAuthToken(json.token);
                    window.setCurrentUserId(json.user_id || window.readUserIdFromToken());
                    let localUnlockFailed = false;
                    try {
                        await window.CryptoEngine?.unlockWithPassword?.(loginPassword, json.user_id || window.getCurrentUserId?.(), json.token || '', {
                            trustedUntil: Date.now() + (window.LeafVaultSession?.CRYPTO_UNLOCK_TTL_MS || 7 * 24 * 60 * 60 * 1000),
                        });
                        window.LeafVaultSession?.setCryptoUnlocked?.();
                    } catch (_) {
                        localUnlockFailed = true;
                        window.LeafVaultSession?.setCryptoLocked?.({ showBanner: true });
                    }
                    try {
                        await window.LeafVaultSession.refreshSessionStatus?.();
                    } catch (_) {
                        // Cookie 状态刷新失败不应撤销后端已成功的登录；后续请求仍会重新校验会话。
                    }
                    const overlay = getLoginOverlay();
                    overlay?.classList.remove('flex');
                    overlay?.classList.add('hidden');
                    event.target.reset();
                    toast(localUnlockFailed ? '账号已登录，本地数据暂时无法解锁。' : '👋  欢迎回来');
                    try {
                        state.initApp();
                    } catch (_) {
                        localUnlockFailed = true;
                    }
                    if (localUnlockFailed) {
                        window.LeafVaultSession?.showLocalDataRecoveryPanel?.('login_unlock_failed');
                    }
                } else {
                    toast(json.message, true);
                }
            } catch (_) {
                toast('登录失败', true);
            }
        });
    }

    function setupDemoModeBindings() {
        const enterBtn = document.getElementById('enterDemoModeBtn');
        if (enterBtn && enterBtn.dataset.demoBound !== '1') {
            enterBtn.dataset.demoBound = '1';
            enterBtn.addEventListener('click', async () => {
                await window.LeafVaultSession?.enterDemoMode?.();
                const overlay = getLoginOverlay();
                overlay?.classList.remove('flex');
                overlay?.classList.add('hidden');
                updateDemoModeBanner();
                toast('已进入 Demo 模式，数据只保存在当前浏览器。');
                state.initApp();
            });
        }

        const exitBtn = document.getElementById('exitDemoModeBtn');
        if (exitBtn && exitBtn.dataset.demoBound !== '1') {
            exitBtn.dataset.demoBound = '1';
            exitBtn.addEventListener('click', () => {
                window.LeafVaultSession?.exitDemoMode?.();
                updateDemoModeBanner();
                state.onLogout();
                const overlay = getLoginOverlay();
                overlay?.classList.remove('hidden');
                overlay?.classList.add('flex');
                toast('已退出 Demo 模式。');
            });
        }

        const clearBtn = document.getElementById('clearDemoDataBtn');
        if (clearBtn && clearBtn.dataset.demoBound !== '1') {
            clearBtn.dataset.demoBound = '1';
            clearBtn.addEventListener('click', async () => {
                if (!window.confirm('清空 Demo 数据只会删除当前浏览器里的 Demo 日记和账本，不会影响正式账号。是否继续？')) return;
                await window.LeafVaultSession?.clearDemoData?.();
                state.initApp();
                toast('Demo 数据已清空。');
            });
        }
    }

    function setupAuthActionBindings() {
        document.querySelectorAll('[data-auth-view]').forEach((el) => {
            if (el.dataset.authActionBound === '1') return;
            el.dataset.authActionBound = '1';
            el.addEventListener('click', () => toggleAuth(el.dataset.authView || 'login'));
        });

        document.querySelectorAll('[data-send-code]').forEach((btn) => {
            if (btn.dataset.sendCodeBound === '1') return;
            btn.dataset.sendCodeBound = '1';
            btn.addEventListener('click', () => {
                sendCode(btn.dataset.emailInput, btn.dataset.actionType, btn);
            });
        });
    }

    function setupPasswordVisibilityToggles() {
        document.querySelectorAll('[data-auth-password-toggle]').forEach((btn) => {
            if (btn.dataset.passwordToggleBound === '1') return;
            btn.dataset.passwordToggleBound = '1';
            btn.addEventListener('click', () => {
                const field = btn.closest('.auth-field');
                const input = field?.querySelector('input[type="password"], input[type="text"]');
                if (!input) return;
                const shouldHide = input.type === 'text';
                input.type = shouldHide ? 'password' : 'text';
                btn.classList.toggle('is-visible', !shouldHide);
                btn.setAttribute('aria-label', shouldHide ? '显示密码' : '隐藏密码');
            });
        });
    }

    function setupPasswordStrengthHint() {
        const regPwdInput = document.querySelector('#registerForm input[name="password"]');
        if (!regPwdInput || regPwdInput.dataset.strengthHintBound === '1') return;
        regPwdInput.dataset.strengthHintBound = '1';

        const hint = document.createElement('p');
        hint.className = 'text-xs mt-1 px-1 hidden';
        regPwdInput.parentNode.insertBefore(hint, regPwdInput.nextSibling);

        regPwdInput.addEventListener('input', function () {
            const value = this.value;
            if (!value) {
                hint.classList.add('hidden');
                return;
            }
            hint.classList.remove('hidden');

            if (value.length < 8) {
                hint.textContent = '❌ 密码长度不足8位';
                hint.className = 'text-xs mt-1 px-1 text-red-500';
            } else if (value.length < 12) {
                hint.textContent = '⚠️ 密码强度一般，建议包含大写字母和数字';
                hint.className = 'text-xs mt-1 px-1 text-yellow-500';
            } else {
                hint.textContent = '✅ 密码强度良好';
                hint.className = 'text-xs mt-1 px-1 text-green-500';
            }
        });
    }

    async function logout() {
        if (window.LeafVaultSession?.isDemoMode?.()) {
            window.LeafVaultSession.exitDemoMode();
            updateDemoModeBanner();
            state.onLogout();
            const overlay = getLoginOverlay();
            overlay?.classList.remove('hidden');
            overlay?.classList.add('flex');
            toast('已退出 Demo 模式。');
            return;
        }
        if (!window.confirm('确定要退出吗？')) return;
        try {
            await window.apiFetch?.('/api/logout', { method: 'POST' });
        } catch (_) {
            try {
                await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
            } catch (_) {}
        }
        window.LeafVaultSession.clearAuthSession();
        if (typeof window.resetLocalDBConnection === 'function') window.resetLocalDBConnection();
        state.onLogout();
        const overlay = getLoginOverlay();
        overlay?.classList.remove('hidden');
        overlay?.classList.add('flex');
        toast('🔒  系统已安全锁定');
    }

    function init(options = {}) {
        Object.assign(state, options);
        setupRegisterForm();
        setupResetForms();
        setupLoginForm();
        setupAuthActionBindings();
        setupPasswordVisibilityToggles();
        setupDemoModeBindings();
        setupPasswordStrengthHint();
        refreshDeploymentStatus();
        updateDemoModeBanner();
    }

    window.LeafVaultAuth = {
        init,
        toggleAuth,
        sendCode,
        logout,
        toggleSettingsResetModal,
        refreshDeploymentStatus,
        applyDeploymentStatus,
        updateDemoModeBanner,
        getDeploymentStatus: () => state.deploymentStatus,
    };
    window.toggleAuth = toggleAuth;
    window.sendCode = sendCode;
    window.logout = logout;
    window.toggleSettingsResetModal = toggleSettingsResetModal;
    window.updateDemoModeBanner = updateDemoModeBanner;
})(window);
