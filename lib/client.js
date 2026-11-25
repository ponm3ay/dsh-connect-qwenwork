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
		 * plugin that owns its own page — same seat dsh-connect-autoclaw / trae /
		 * workbuddy / qoder use. The shell draws the nav row, the title and the
		 * close control; this module draws only the page body.
		 *
		 * The browser never sees a token: it asks the Host's loopback routes for
		 * "am I signed in", and opens the authorization page the Host hands back.
		 */

		var NS = "dsh-connect-qwenwork";
		var BASE = "/plugins/dsh-connect-qwenwork";
		var SECTION_ID = "qwenwork";

		/** Text, Chinese only — matching the plugin's other copy. */
		var TEXT = {
			title: "千问办公",
			checking: "正在读取账号状态…",
			signedOut: "还没登录",
			signedIn: "已登录",
			expired: "凭据已过期",
			account: "账号",
			plan: "套餐",
			balance: "办公积分",
			balanceLoading: "读取中…",
			balanceUnknown: "暂时读不到",
			expiresAt: "有效期至",
			expiredAt: "已于 {time} 过期",
			refresh: "刷新",
			refreshCredits: "查积分",
			login: "登录",
			loginStarting: "正在打开授权页…",
			waiting: "等待浏览器授权…",
			cancel: "取消",
			logout: "退出登录",
			logoutConfirm: "确定退出？退出后需要重新在浏览器授权。",
			confirm: "确定",
			models: "可用模型",
			modelsRefresh: "刷新列表",
			modelsRefreshing: "读取中…",
			modelsRefreshedAt: "上次刷新 {time}",
			store: "凭据文件",
			runtime: "签名组件",
			runtimeOk: "{version}（{release}）",
			runtimeMissing: "找不到签名组件",
			hint: "在浏览器里授权自己的千问办公账号。登录状态保存在本机，浏览器不接触 token。",
			unavailable: "读不到插件接口（宿主没有提供路由，或连接已断开）。",
			retry: "重试",
			signedInAs: "已登录：{account}",
			loginStarted: "已在浏览器打开授权页，完成后回到这里。",
			loginDone: "授权完成。",
			loginFailed: "授权失败：{msg}",
			modelsFailed: "刷新失败：{msg}",
			logoutFailed: "退出失败：{msg}",
		};

		function t(key, vars) {
			var text = TEXT[key] || key;
			if (vars === undefined) return text;
			return text.replace(/\{(\w+)\}/g, function (match, name) {
				return vars[name] === undefined ? match : String(vars[name]);
			});
		}

		var CSS = `
.dsq-root{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dsq-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dsq-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsq-title{font-size:14px;font-weight:600}
.dsq-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsq-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dsq-dot{width:7px;height:7px;border-radius:50%;flex:none}
.dsq-dot-on{background:var(--dsw-alias-state-success-primary)}
.dsq-dot-off{background:var(--dsw-alias-label-tertiary)}
.dsq-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.dsq-dot-err{background:var(--dsw-alias-state-error-primary)}
.dsq-on{color:var(--dsw-alias-state-success-primary)}
.dsq-warn{color:var(--dsw-alias-state-warn-primary)}
.dsq-err{color:var(--dsw-alias-state-error-primary)}
.dsq-muted{color:var(--dsw-alias-label-tertiary)}
.dsq-grid{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;font-size:12.5px;align-items:baseline}
.dsq-k{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsq-v{min-width:0;overflow-wrap:anywhere}
.dsq-v code{font-family:var(--dsw-font-mono);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dsq-balance{font-size:28px;font-weight:700;letter-spacing:.3px;font-variant-numeric:tabular-nums;line-height:1.1}
.dsq-wallets{display:flex;flex-wrap:wrap;gap:6px}
.dsq-wallet{font-size:11.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px}
.dsq-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dsq-btn{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:6px 12px;font:inherit;font-size:12.5px;line-height:1.3;cursor:pointer;white-space:nowrap}
.dsq-btn[disabled]{cursor:default;opacity:.55}
.dsq-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}
.dsq-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsq-ghost{background:transparent;border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsq-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsq-note{font-size:12.5px;border-radius:var(--dsw-radius-md);padding:8px 10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.dsq-note-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsq-note-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-secondary)}
.dsq-models{display:flex;flex-wrap:wrap;gap:6px}
.dsq-model{font-family:var(--dsw-font-mono);font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:1px 6px}
.dsq-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsq-wait{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12.5px}
.dsq-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.dsq-btn{transition:none}}
`;

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
			if (status === undefined) return { tone: "off", text: t("checking") };
			if (status.error !== undefined && status.loggedIn !== true) return { tone: "err", text: t("unavailable") };
			if (status.loggedIn !== true) return { tone: "off", text: t("signedOut") };
			if (status.expired === true) return { tone: "err", text: t("expired") };
			if (typeof status.expiresInMs === "number" && status.expiresInMs < 15 * 60000) return { tone: "warn", text: t("signedIn") };
			return { tone: "on", text: t("signedIn") };
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
			var body = [];

			body.push(h("div", { key: "head", className: "dsq-card-head" },
				h("div", null,
					h("div", { className: "dsq-title" }, t("title")),
					h("div", { className: "dsq-sub" }, t("hint"))),
				h("span", { className: "dsq-state" },
					h("span", { className: "dsq-dot dsq-dot-" + state.tone }),
					h("span", { className: state.tone === "on" ? "dsq-on" : state.tone === "warn" ? "dsq-warn" : state.tone === "err" ? "dsq-err" : "dsq-muted" }, state.text))));

			if (status !== undefined && status.loggedIn === true) {
				var rows = [];
				if (status.account) rows.push(h("div", { key: "k-account", className: "dsq-k" }, t("account")), h("div", { key: "v-account", className: "dsq-v" }, maskAccount(status.account)));
				if (status.plan) rows.push(h("div", { key: "k-plan", className: "dsq-k" }, t("plan")), h("div", { key: "v-plan", className: "dsq-v" }, String(status.plan)));
				if (status.expires) rows.push(h("div", { key: "k-exp", className: "dsq-k" }, t("expiresAt")), h("div", { key: "v-exp", className: "dsq-v" }, when(status.expires) + (remaining(status.expiresInMs) ? "（剩 " + remaining(status.expiresInMs) + "）" : "")));
				if (status.store) rows.push(h("div", { key: "k-store", className: "dsq-k" }, t("store")), h("div", { key: "v-store", className: "dsq-v" }, h("code", null, String(status.store))));
				if (status.runtime) {
					rows.push(h("div", { key: "k-rt", className: "dsq-k" }, t("runtime")));
					rows.push(h("div", { key: "v-rt", className: "dsq-v" },
						status.runtime.available === true
							? t("runtimeOk", { version: status.runtime.version, release: status.runtime.releaseVersion })
							: t("runtimeMissing")));
				}
				if (rows.length > 0) body.push(h("div", { key: "grid", className: "dsq-grid" }, rows));

				var balanceText = status.balance === undefined
					? t("balanceLoading")
					: status.balance.unavailable === true
						? t("balanceUnknown")
						: status.balance.balance || t("balanceUnknown");
				var wallets = status.balance && Array.isArray(status.balance.windows) ? status.balance.windows : [];
				body.push(h("div", { key: "balance" },
					h("div", { className: "dsq-muted", style: { fontSize: "12px" } }, t("balance")),
					h("div", { className: "dsq-balance" }, String(balanceText)),
					wallets.length > 0
						? h("div", { className: "dsq-wallets" }, wallets.map(function (row, index) {
							return h("span", { key: "w" + index, className: "dsq-wallet" }, (row.name || "积分") + " " + String(row.display || ""));
						}))
						: null));

				body.push(h("div", { key: "actions", className: "dsq-row" },
					h("button", { type: "button", className: "dsq-btn dsq-ghost", onClick: function () { load(true); } }, t("refreshCredits")),
					h("button", { type: "button", className: "dsq-btn dsq-ghost", onClick: function () { load(false); } }, t("refresh")),
					confirming
						? h("span", { className: "dsq-row" },
							h("span", { className: "dsq-hint" }, t("logoutConfirm")),
							h("button", { type: "button", className: "dsq-btn dsq-danger", onClick: logout }, t("confirm")),
							h("button", { type: "button", className: "dsq-btn dsq-ghost", onClick: function () { setConfirming(false); } }, t("cancel")))
						: h("button", { type: "button", className: "dsq-btn dsq-danger", onClick: function () { setConfirming(true); } }, t("logout"))));
			} else {
				body.push(h("div", { key: "login", className: "dsq-row" },
					login === undefined
						? h("button", { type: "button", className: "dsq-btn dsq-primary", disabled: busy, onClick: startLogin },
							busy ? t("loginStarting") : t("login"))
						: h("span", { className: "dsq-wait" },
							h("span", { className: "dsq-muted" }, t("waiting")),
							h("button", { type: "button", className: "dsq-btn dsq-ghost", onClick: cancelLogin }, t("cancel")))));

				if (login !== undefined) {
					body.push(h("div", { key: "loginUrl", className: "dsq-note" },
						h("div", null, login.instructions || t("loginStarted")),
						typeof login.url === "string" && login.url !== ""
							? h("div", null, h("a", { className: "dsq-link", href: login.url, target: "_blank", rel: "noopener noreferrer" }, login.url))
							: null));
				}
			}

			var models = Array.isArray(status && status.models) ? status.models : [];
			if (models.length > 0) {
				body.push(h("div", { key: "models" },
					h("div", { className: "dsq-row", style: { justifyContent: "space-between" } },
						h("div", { className: "dsq-sub" }, t("models") + "（" + models.length + "）"),
						h("button", { type: "button", className: "dsq-btn dsq-ghost", disabled: busy, onClick: refreshModels },
							busy ? t("modelsRefreshing") : t("modelsRefresh"))),
					h("div", { className: "dsq-models", style: { marginTop: "6px" } }, models.map(function (model) {
						return h("span", { key: model.id, className: "dsq-model", title: model.id }, model.name || model.id);
					}))));
			}

			if (modelsNote) body.push(h("div", { key: "modelsNote", className: "dsq-note " + (modelsNote.tone === "ok" ? "dsq-note-ok" : "dsq-note-err") }, modelsNote.text));
			if (note) body.push(h("div", { key: "note", className: "dsq-note " + (note.tone === "ok" ? "dsq-note-ok" : "dsq-note-err") }, note.text));
			if (status && status.note) body.push(h("div", { key: "statusNote", className: "dsq-note dsq-note-err" }, String(status.note)));

			return h("div", { className: "dsq-root" }, h("section", { className: "dsq-card" }, body));
		}

		var inject = ["slots"];

		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: 37,
						label: function () { return TEXT.title; },
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
				SECTION_ID: SECTION_ID,
			},
		};
		return module.exports;
	},
});
