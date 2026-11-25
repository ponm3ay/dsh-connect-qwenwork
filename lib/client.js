window.__ModuleLoader__.load({
	id: "dsh-connect-qwenwork",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		/**
		 * QwenWork settings panel (browser half).
		 *
		 * Registered into `settings.section`, the seat the Settings shell gives a
		 * plugin that owns its own page — the same seat dsh-connect-trae /
		 * workbuddy / qoder use. The shell draws the nav row, the title and the
		 * close control; this module draws only the page body.
		 *
		 * Design notes, learned from those three panels rather than invented here:
		 *   - a page header (title + one-line description) above the cards;
		 *   - cards on `bg-layer-3` with a `border-l2` hairline and 12px radius;
		 *   - status is a dot + word, never a colour alone;
		 *   - every metric is `font-variant-numeric: tabular-nums` so digits do not
		 *     jitter between polls;
		 *   - only tokens that exist in design-platform.css, each with a literal
		 *     fallback so a theme that drops one still renders;
		 *   - styles injected once through a `data-plugin-css` tag, the way the
		 *     Trae panel does it.
		 *
		 * The browser never sees a token: it asks the Host's loopback routes for
		 * "am I signed in", and opens the authorization page the Host hands back.
		 */

		var NS = "dsh-connect-qwenwork";
		var BASE = "/plugins/dsh-connect-qwenwork";
		var SECTION_ID = "qwenwork";

		/** Text, Chinese only — matching the plugin's other copy. */
		var TEXT = {
			pageTitle: "千问办公",
			pageDesc: "用自己的千问办公账号在浏览器授权，然后在模型选择器里直接选它的模型。",
			checking: "正在读取…",
			signedOut: "未登录",
			signedIn: "已登录",
			expired: "已过期",
			expiringSoon: "即将过期",
			account: "账号",
			plan: "套餐",
			balance: "办公积分",
			balanceLoading: "读取中…",
			balanceUnknown: "读不到",
			expiresAt: "有效期至",
			store: "凭据文件",
			runtime: "签名组件",
			runtimeOk: "{version} · {release}",
			runtimeMissing: "找不到",
			refresh: "刷新",
			refreshCredits: "查积分",
			login: "登录",
			loginStarting: "正在打开…",
			waiting: "等待浏览器授权",
			cancel: "取消",
			logout: "退出登录",
			logoutConfirm: "退出后需要重新在浏览器授权。",
			confirm: "退出",
			models: "可用模型",
			modelsRefresh: "刷新列表",
			modelsRefreshing: "读取中…",
			modelsRefreshedAt: "上次刷新 {time}",
			modelsEmpty: "登录后这里会列出该账号可用的模型。",
			modelsNone: "该账号的目录里没有可用模型，试试刷新列表。",
			modelsSummary: "已开启 {on} / {total} 个；关掉的不会出现在模型选择器里。",
			modelOn: "开启",
			modelOff: "关闭",
			modelToggleFailed: "切换失败：{msg}",
			hint: "登录状态只保存在本机，浏览器那一半拿不到 token。",
			unavailable: "读不到插件接口",
			retry: "重试",
			loginStarted: "已在浏览器打开授权页，完成后回到这里，会自动继续。",
			loginDone: "授权完成",
			loginFailed: "授权失败：{msg}",
			modelsFailed: "刷新失败：{msg}",
			logoutFailed: "退出失败：{msg}",
			sectionAccount: "账号",
			sectionModels: "模型",
			sectionDiagnostics: "诊断",
			reauth: "重新登录",
		};

		function t(key, vars) {
			var text = TEXT[key] || key;
			if (vars === undefined) return text;
			return text.replace(/\{(\w+)\}/g, function (match, name) {
				return vars[name] === undefined ? match : String(vars[name]);
			});
		}

		/**
		 * The panel stylesheet.
		 *
		 * Every `var()` carries a literal fallback: a host theme that stops
		 * exporting a token degrades to a readable colour instead of `unset`.
		 * The prefix is `dsq-`, distinct from the `dsm-` the other connectors use
		 * so two panels open in one page cannot collide.
		 */
		var CSS = [
			'.dsq-root{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.5}',
			// page header
			'.dsq-head{display:flex;flex-direction:column;gap:4px}',
			'.dsq-head-title{margin:0;font-size:20px;font-weight:600;line-height:1.4;letter-spacing:.1px}',
			'.dsq-head-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}',
			// card
			'.dsq-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:12px;background:var(--dsw-alias-bg-layer-3,#202126);transition:border-color .16s}',
			'.dsq-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;flex-wrap:wrap}',
			'.dsq-card-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}',
			'.dsq-card-body{display:flex;flex-direction:column;gap:14px;margin:0 16px;padding:14px 0 16px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}',
			'.dsq-card-body>p{margin:0}',
			'.dsq-card-body:empty{display:none}',
			// status pill
			'.dsq-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#24262c);font-size:11.5px;font-weight:600;line-height:18px;white-space:nowrap}',
			'.dsq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}',
			'.dsq-tone-on{color:var(--dsw-alias-state-success-primary,#22c55e)}',
			'.dsq-tone-off{color:var(--dsw-alias-label-tertiary,#999)}',
			'.dsq-tone-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
			'.dsq-tone-err{color:var(--dsw-alias-state-error-primary,#ef4444)}',
			'.dsq-pill.dsq-tone-on{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 34%,transparent)}',
			'.dsq-pill.dsq-tone-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 34%,transparent)}',
			'.dsq-pill.dsq-tone-err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 34%,transparent)}',
			'.dsq-dot-live{animation:dsq-pulse 2s ease-in-out infinite}',
			'@keyframes dsq-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
			// metric grid
			'.dsq-grid{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 18px;align-items:baseline}',
			'.dsq-k{font-size:12.5px;color:var(--dsw-alias-label-secondary,#b4b4b4);white-space:nowrap}',
			'.dsq-v{min-width:0;overflow-wrap:anywhere;font-size:12.5px}',
			'.dsq-v code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#b4b4b4)}',
			'.dsq-v-dim{color:var(--dsw-alias-label-tertiary,#999)}',
			// hero balance
			'.dsq-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}',
			'.dsq-hero-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
			'.dsq-hero-num{margin-top:2px;font-size:30px;font-weight:650;line-height:1.1;letter-spacing:.2px;font-variant-numeric:tabular-nums}',
			'.dsq-hero-num-sm{font-size:15px;font-weight:600}',
			'.dsq-hero-unit{margin-left:4px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary,#999)}',
			'.dsq-wallets{display:flex;flex-wrap:wrap;gap:6px}',
			'.dsq-wallet{padding:1px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#24262c);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#b4b4b4)}',
			// buttons
			'.dsq-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.dsq-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;transition:background .16s,border-color .16s,color .16s,opacity .16s}',
			'.dsq-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}',
			'.dsq-btn:disabled{opacity:.4;cursor:default}',
			'.dsq-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126);font-weight:600}',
			'.dsq-btn-primary:hover:not(:disabled){opacity:.88}',
			'.dsq-btn-outline{border-color:var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#b4b4b4);background:transparent;font-weight:500}',
			'.dsq-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#8a8a8a);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04))}',
			'.dsq-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444);background:transparent;font-weight:500}',
			'.dsq-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent)}',
			// notes
			'.dsq-note{display:flex;gap:8px;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#24262c);font-size:12.5px;line-height:1.5}',
			'.dsq-note-ok{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 30%,transparent)}',
			'.dsq-note-err{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 30%,transparent)}',
			// login waiting block
			'.dsq-wait{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2,#36373b);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5686fe) 5%,var(--dsw-alias-bg-layer-2,#24262c))}',
			'.dsq-wait-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}',
			'.dsq-spinner{width:13px;height:13px;flex:none;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-primary,#e6e6e6) 22%,transparent);border-top-color:var(--dsw-alias-label-primary,#e6e6e6);animation:dsq-spin .8s linear infinite}',
			'@keyframes dsq-spin{to{transform:rotate(360deg)}}',
			'.dsq-link{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,#5686fe));text-decoration:none;overflow-wrap:anywhere;font-size:12px}',
			'.dsq-link:hover{text-decoration:underline}',
			// model chips
			'.dsq-chips{display:flex;flex-wrap:wrap;gap:6px}',
			'.dsq-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#24262c);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#b4b4b4)}',
			// model rows with a real switch
			'.dsq-models{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}',
			'.dsq-model{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,#24262c);border-top:1px solid var(--dsw-alias-border-l2,#36373b)}',
			'.dsq-model:first-child{border-top:0}',
			'.dsq-model-name{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:18px;overflow-wrap:anywhere}',
			'.dsq-model-id{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}',
			'.dsq-model-off .dsq-model-name{color:var(--dsw-alias-label-tertiary,#999)}',
			// switch: a real checkbox with a painted track, the pattern the other
			// connectors use, so keyboard and screen-reader behaviour comes free.
			'.dsq-sw{position:relative;display:inline-block;width:36px;height:20px;flex:none;cursor:pointer}',
			'.dsq-sw input{position:absolute;opacity:0;width:0;height:0}',
			'.dsq-sw-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2,#3a3d45);transition:background .18s}',
			'.dsq-sw-track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-3,#fff);transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.3)}',
			'.dsq-sw input:checked+.dsq-sw-track{background:var(--dsw-alias-state-success-primary,#22c55e)}',
			'.dsq-sw input:checked+.dsq-sw-track::after{transform:translateX(16px)}',
			'.dsq-sw input:focus-visible+.dsq-sw-track{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}',
			'.dsq-sw input:disabled+.dsq-sw-track{opacity:.4;cursor:default}',
			'.dsq-chip-eye{opacity:.65;font-size:10px}',
			'.dsq-empty{margin:0;padding:2px 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#999)}',
			'.dsq-foot{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
			'@media (prefers-reduced-motion:reduce){.dsq-btn{transition:none}.dsq-dot-live,.dsq-spinner{animation:none}}',
		].join('\n');

		/** Inject the stylesheet once per page, tagged so it is never doubled. */
		function injectCss() {
			if (typeof document === 'undefined') return;
			var id = 'dsh-connect-qwenwork/client.css';
			if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
			var tag = document.createElement('style');
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** One fetch against this plugin's routes; always resolves, never throws. */
		function call(path, options) {
			var init = Object.assign({ credentials: "same-origin", headers: { accept: "application/json" } }, options || {});
			return fetch(BASE + path, init)
				.then(function (response) {
					return response.text().then(function (text) {
						var payload;
						try {
							payload = text === "" ? {} : JSON.parse(text);
						} catch (error) {
							payload = { error: "响应不是 JSON（HTTP " + response.status + "）" };
						}
						if (!response.ok && payload.error === undefined) {
							payload.error = "HTTP " + response.status;
						}
						return payload;
					});
				})
				.catch(function (error) {
					return { error: error && error.message ? error.message : String(error) };
				});
		}

		function post(path) {
			return call(path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" });
		}

		/** Mask an account for display: keep the local part's first two chars. */
		function maskAccount(value) {
			var text = String(value || "");
			var at = text.indexOf("@");
			if (at <= 2) return text;
			return text.slice(0, 2) + "***" + text.slice(at);
		}

		function when(iso) {
			if (typeof iso !== "string" || iso === "") return undefined;
			var date = new Date(iso);
			if (isNaN(date.getTime())) return undefined;
			return date.toLocaleString("zh-CN", { hour12: false });
		}

		function remaining(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return undefined;
			if (ms <= 0) return "已过期";
			var days = Math.floor(ms / 86400000);
			if (days >= 1) return days + " 天";
			var hours = Math.floor(ms / 3600000);
			if (hours >= 1) return hours + " 小时";
			return Math.max(1, Math.floor(ms / 60000)) + " 分钟";
		}

		function stateOf(status) {
			if (status === undefined) return { tone: "off", text: t("checking"), live: false };
			if (status.error !== undefined && status.loggedIn !== true) return { tone: "err", text: t("unavailable"), live: false };
			if (status.loggedIn !== true) return { tone: "off", text: t("signedOut"), live: false };
			if (status.expired === true) return { tone: "err", text: t("expired"), live: false };
			if (typeof status.expiresInMs === "number" && status.expiresInMs < 15 * 60000) return { tone: "warn", text: t("expiringSoon"), live: false };
			return { tone: "on", text: t("signedIn"), live: true };
		}

		/**
		 * Split a balance display like "剩余 1,234.5 积分" into the number, the text
		 * before it, and the unit after it, so the panel can set the number large
		 * and keep the words small. A display with no number at all stays whole.
		 */
		function splitBalance(text) {
			var value = String(text || "");
			var match = value.match(/^([^\d-]*?)(-?[\d,]+(?:\.\d+)?)([\s\S]*)$/);
			if (match === null) return { lead: "", num: value, suffix: "" };
			return { lead: match[1], num: match[2], suffix: match[3].trim() };
		}

		/** The dot + word pill. Colour is never the only signal — the word is always there. */
		function StatusPill(props) {
			var state = props.state;
			return h("span", { className: "dsq-pill dsq-tone-" + state.tone },
				h("span", { className: "dsq-dot" + (state.live ? " dsq-dot-live" : "") }),
				h("span", null, state.text));
		}

		function Card(props) {
			return h("section", { className: "dsq-card" },
				h("div", { className: "dsq-card-head" }, props.head),
				props.body === undefined ? null : h("div", { className: "dsq-card-body" }, props.body));
		}

		function QwenWorkSection() {
			var statusState = React.useState(undefined);
			var status = statusState[0];
			var setStatus = statusState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var noteState = React.useState(undefined);
			var note = noteState[0];
			var setNote = noteState[1];
			var confirmingState = React.useState(false);
			var confirming = confirmingState[0];
			var setConfirming = confirmingState[1];
			var modelsNoteState = React.useState(undefined);
			var modelsNote = modelsNoteState[0];
			var setModelsNote = modelsNoteState[1];
			var loginState = React.useState(undefined);
			var login = loginState[0];
			var setLogin = loginState[1];

			/** Read /status; `credits` also asks the Host for the credit balance. */
			function load(withCredits) {
				var target = BASE + "/status" + (withCredits === true ? "?credits=1" : "");
				fetch(target, { credentials: "same-origin", headers: { accept: "application/json" } })
					.then(function (response) {
						return response.json().catch(function () { return { error: "HTTP " + response.status }; });
					})
					.then(function (payload) { setStatus(payload); })
					.catch(function (error) {
						setStatus({ error: error && error.message ? error.message : String(error) });
					});
			}

			React.useEffect(function () { load(false); }, []);

			/** Start one browser authorization, then poll until it lands. */
			function startLogin() {
				setBusy(true);
				setNote(undefined);
				post("/login").then(function (payload) {
					setBusy(false);
					if (payload.error !== undefined) {
						setNote({ tone: "err", text: String(payload.error) });
						return;
					}
					setLogin({ url: payload.url, instructions: payload.instructions });
					if (typeof payload.url === "string" && payload.url !== "") {
						try { window.open(payload.url, "_blank", "noopener,noreferrer"); } catch (error) { /* the link is shown too */ }
					}
				});
			}

			function cancelLogin() {
				post("/cancel").then(function () {
					setLogin(undefined);
					load(false);
				});
			}

			function logout() {
				post("/logout").then(function (payload) {
					setConfirming(false);
					setLogin(undefined);
					if (payload.error !== undefined) {
						setNote({ tone: "err", text: t("logoutFailed", { msg: String(payload.error) }) });
						return;
					}
					setNote(undefined);
					load(false);
				});
			}

			function refreshModels() {
				setBusy(true);
				setModelsNote(undefined);
				post("/models").then(function (payload) {
					setBusy(false);
					if (payload.error !== undefined) {
						setModelsNote({ tone: "err", text: t("modelsFailed", { msg: String(payload.error) }) });
						return;
					}
					setModelsNote({ tone: "ok", text: t("modelsRefreshedAt", { time: when(new Date().toISOString()) }) });
					load(false);
				});
			}

			/**
			 * Switch one model on or off.
			 *
			 * The Host owns the write and answers with the whole list, so the panel
			 * repaints from its truth instead of from an optimistic guess. A failed
			 * write leaves the previous state in place and says why.
			 */
			function toggleModel(model, enabled) {
				setModelsNote(undefined);
				call("/model", {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ id: model.id, enabled: enabled }),
				}).then(function (payload) {
					if (payload.error !== undefined) {
						setModelsNote({ tone: "err", text: t("modelToggleFailed", { msg: String(payload.error) }) });
						return;
					}
					setStatus(function (previous) {
						if (previous === undefined) return previous;
						return Object.assign({}, previous, { models: payload.models });
					});
				});
			}

			// Poll while an authorization is pending. The Host owns the poll loop;
			// this only asks whether it landed, once a second.
			React.useEffect(function () {
				if (login === undefined) return undefined;
				var stopped = false;
				var timer = window.setInterval(function () {
					call("/login").then(function (payload) {
						if (stopped) return;
						if (payload.loggingIn === true) return;
						window.clearInterval(timer);
						if (payload.done === true || payload.loggedIn === true) {
							setLogin(undefined);
							setNote({ tone: "ok", text: t("loginDone") });
							load(false);
							return;
						}
						setLogin(undefined);
						setNote({ tone: "err", text: t("loginFailed", { msg: String(payload.error || "未完成") }) });
					});
				}, 1000);
				return function () { stopped = true; window.clearInterval(timer); };
			}, [login === undefined ? "" : login.url]);

			var state = stateOf(status);
			var signedIn = status !== undefined && status.loggedIn === true;
			var models = Array.isArray(status && status.models) ? status.models : [];
			var cards = [];

			// ---- account card -------------------------------------------------
			var accountBody = [];
			if (signedIn) {
				var rows = [];
				if (status.account) {
					rows.push(h("div", { key: "k-account", className: "dsq-k" }, t("account")));
					rows.push(h("div", { key: "v-account", className: "dsq-v" }, maskAccount(status.account)));
				}
				if (status.plan) {
					rows.push(h("div", { key: "k-plan", className: "dsq-k" }, t("plan")));
					rows.push(h("div", { key: "v-plan", className: "dsq-v" }, String(status.plan)));
				}
				if (status.expires) {
					rows.push(h("div", { key: "k-exp", className: "dsq-k" }, t("expiresAt")));
					rows.push(h("div", { key: "v-exp", className: "dsq-v" },
						when(status.expires),
						remaining(status.expiresInMs) === undefined
							? null
							: h("span", { className: "dsq-v-dim" }, " · 剩 " + remaining(status.expiresInMs))));
				}
				if (rows.length > 0) accountBody.push(h("div", { key: "grid", className: "dsq-grid" }, rows));

				// balance hero
				var balance = status.balance;
				var balanceText = balance === undefined
					? t("balanceLoading")
					: balance.unavailable === true
						? t("balanceUnknown")
						: balance.balance || t("balanceUnknown");
				var split = splitBalance(balanceText);
				var wallets = balance && Array.isArray(balance.windows) ? balance.windows : [];
				var known = balance !== undefined && balance.unavailable !== true;
				// Only a second wallet is worth a chip: repeating the hero number as a
				// pill is noise. The hero already carries the primary balance.
				var extraWallets = wallets.slice(1);
				accountBody.push(h("div", { key: "hero", className: "dsq-hero" },
					h("div", null,
						h("div", { className: "dsq-hero-label" }, t("balance")),
						h("div", { className: "dsq-hero-num" + (known ? "" : " dsq-hero-num-sm") },
							split.num,
							split.suffix === "" ? null : h("span", { className: "dsq-hero-unit" }, " " + split.suffix))),
					extraWallets.length > 0
						? h("div", { className: "dsq-wallets" }, extraWallets.map(function (row, index) {
							return h("span", { key: "w" + index, className: "dsq-wallet", title: String(row.display || "") },
								(row.name || "积分") + " " + String(row.display || ""));
						}))
						: null));

				accountBody.push(h("div", { key: "actions", className: "dsq-row" },
					h("button", { type: "button", className: "dsq-btn dsq-btn-outline", onClick: function () { load(true); } }, t("refreshCredits")),
					h("button", { type: "button", className: "dsq-btn dsq-btn-outline", onClick: startLogin, disabled: busy },
						busy ? t("loginStarting") : t("reauth")),
					confirming
						? h("span", { className: "dsq-row" },
							h("span", { className: "dsq-foot" }, t("logoutConfirm")),
							h("button", { type: "button", className: "dsq-btn dsq-btn-danger", onClick: logout }, t("confirm")),
							h("button", { type: "button", className: "dsq-btn dsq-btn-outline", onClick: function () { setConfirming(false); } }, t("cancel")))
						: h("button", { type: "button", className: "dsq-btn dsq-btn-danger", onClick: function () { setConfirming(true); } }, t("logout"))));
			} else {
				accountBody.push(h("p", { key: "lead", className: "dsq-head-desc" }, t("hint")));
				if (login === undefined) {
					accountBody.push(h("div", { key: "cta", className: "dsq-row" },
						h("button", { type: "button", className: "dsq-btn dsq-btn-primary", disabled: busy, onClick: startLogin },
							busy ? t("loginStarting") : t("login"))));
				} else {
					accountBody.push(h("div", { key: "wait", className: "dsq-wait" },
						h("div", { className: "dsq-wait-head" },
							h("span", { className: "dsq-spinner" }),
							h("span", null, t("waiting"))),
						h("div", { className: "dsq-foot" }, login.instructions || t("loginStarted")),
						typeof login.url === "string" && login.url !== ""
							? h("a", { className: "dsq-link", href: login.url, target: "_blank", rel: "noopener noreferrer" }, login.url)
							: null,
						h("div", { className: "dsq-row" },
							h("button", { type: "button", className: "dsq-btn dsq-btn-outline", onClick: cancelLogin }, t("cancel")))));
				}
			}
			if (note) accountBody.push(h("div", { key: "note", className: "dsq-note " + (note.tone === "ok" ? "dsq-note-ok" : "dsq-note-err") }, note.text));
			if (status && status.note) accountBody.push(h("div", { key: "statusNote", className: "dsq-note dsq-note-err" }, String(status.note)));

			cards.push(h(Card, {
				key: "account",
				head: [h("h3", { key: "t", className: "dsq-card-title" }, t("sectionAccount")), h(StatusPill, { key: "p", state: state })],
				body: accountBody,
			}));

			// ---- models card --------------------------------------------------
			// A signed-out install must not advertise models it cannot serve: the
			// fallback catalog is a snapshot, not a claim about this account. The
			// card is only worth drawing once there is an account behind it.
			var modelsBody = [];
			if (signedIn) {
				if (models.length === 0) {
					modelsBody.push(h("p", { key: "empty", className: "dsq-empty" }, t("modelsNone")));
				} else {
					var onCount = models.filter(function (model) { return model.enabled !== false; }).length;
					modelsBody.push(h("p", { key: "summary", className: "dsq-foot" }, t("modelsSummary", { on: onCount, total: models.length })));
					modelsBody.push(h("div", { key: "list", className: "dsq-models" }, models.map(function (model) {
						var on = model.enabled !== false;
						return h("div", { key: model.id, className: "dsq-model" + (on ? "" : " dsq-model-off") },
							h("label", { className: "dsq-sw", title: on ? t("modelOff") : t("modelOn") },
								h("input", {
									type: "checkbox",
									checked: on,
									disabled: busy,
									"aria-label": (model.name || model.id) + " " + (on ? t("modelOn") : t("modelOff")),
									onChange: function (event) { toggleModel(model, event.target.checked); },
								}),
								h("span", { className: "dsq-sw-track" })),
							h("span", { className: "dsq-model-name" }, model.name || model.id),
							h("span", { className: "dsq-model-id" }, model.id));
					})));
				}
				modelsBody.push(h("div", { key: "actions", className: "dsq-row" },
					h("button", { type: "button", className: "dsq-btn dsq-btn-outline", disabled: busy, onClick: refreshModels },
						busy ? t("modelsRefreshing") : t("modelsRefresh")),
					h("span", { className: "dsq-foot" },
						status && status.modelsRefreshedAt
							? t("modelsRefreshedAt", { time: when(new Date(status.modelsRefreshedAt).toISOString()) })
							: "")));
				if (modelsNote) modelsBody.push(h("div", { key: "note", className: "dsq-note " + (modelsNote.tone === "ok" ? "dsq-note-ok" : "dsq-note-err") }, modelsNote.text));

				var onTotal = models.filter(function (model) { return model.enabled !== false; }).length;
				cards.push(h(Card, {
					key: "models",
					head: h("h3", { className: "dsq-card-title" }, t("models") + "（" + onTotal + "/" + models.length + "）"),
					body: modelsBody,
				}));
			}

			// ---- diagnostics card ---------------------------------------------
			var diagRows = [];
			if (status && status.store) {
				diagRows.push(h("div", { key: "k-store", className: "dsq-k" }, t("store")));
				diagRows.push(h("div", { key: "v-store", className: "dsq-v" }, h("code", null, String(status.store))));
			}
			if (status && status.runtime) {
				diagRows.push(h("div", { key: "k-rt", className: "dsq-k" }, t("runtime")));
				diagRows.push(h("div", { key: "v-rt", className: "dsq-v" + (status.runtime.available === true ? "" : " dsq-v-dim") },
					status.runtime.available === true
						? t("runtimeOk", { version: status.runtime.version, release: status.runtime.releaseVersion })
						: t("runtimeMissing") + (status.runtime.error ? "：" + String(status.runtime.error) : "")));
			}
			if (diagRows.length > 0) {
				cards.push(h(Card, {
					key: "diagnostics",
					head: h("h3", { className: "dsq-card-title" }, t("sectionDiagnostics")),
					body: [h("div", { key: "grid", className: "dsq-grid" }, diagRows)],
				}));
			}

			return h("div", { className: "dsq-root" },
				h("header", { className: "dsq-head" },
					h("h2", { className: "dsq-head-title" }, t("pageTitle")),
					h("p", { className: "dsq-head-desc" }, t("pageDesc"))),
				cards);
		}

		var inject = ["slots"];

		function apply(ctx) {
			try {
				injectCss();
			} catch (error) {
				console.error("[dsh-connect-qwenwork] stylesheet injection failed:", error);
			}
			try {
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: 37,
						label: function () { return TEXT.pageTitle; },
					}, QwenWorkSection);
				});
			} catch (error) {
				console.error("[dsh-connect-qwenwork] settings panel failed to register (host provider unaffected):", error);
			}
		}

		module.exports = {
			inject: inject,
			apply: apply,
			__test: {
				t: t,
				stateOf: stateOf,
				remaining: remaining,
				when: when,
				maskAccount: maskAccount,
				splitBalance: splitBalance,
				SECTION_ID: SECTION_ID,
			},
		};
		return module.exports;
	},
});
