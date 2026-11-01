// dsh-prompt-manager client half — a settings.section tab for viewing the
// live system-prompt catalog, managing/switching prompt presets (builtin vs
// personalized, toggle switches), and visualizing the assembly pipeline
// (幕布): how sections from different sources aggregate into the final prompt.
// Served as a browser module through the client module host; talks to the
// host half over the dedicated /prompt-manager-rpc Connection RPC channel.
window.__ModuleLoader__.load({
	id: "dsh-prompt-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const { useCallback, useEffect, useState } = react;
		const createElement = react.createElement;

		// ── style kit (native theme tokens) ───────────────────────────────────
		const styles = {
			root: { display: "flex", flexDirection: "column", gap: 12, color: "var(--dsw-alias-label-primary)" },
			card: {
				background: "var(--dsw-alias-bg-module-platform)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 12,
				padding: "12px 14px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			title: { fontSize: 13, fontWeight: 500, lineHeight: 1.5, margin: 0 },
			hint: { fontSize: 12, lineHeight: 1.6, margin: 0, color: "var(--dsw-alias-label-tertiary)" },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			pre: {
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				fontFamily: "var(--ds-font-family-code, monospace)",
				fontSize: 12,
				lineHeight: 1.5,
				margin: 0,
				maxHeight: 240,
				overflow: "auto",
				color: "var(--dsw-alias-label-secondary)"
			},
			sectionHead: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
			sectionName: { fontSize: 12, fontWeight: 600, fontFamily: "var(--ds-font-family-code, monospace)" },
			badge: {
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-secondary)",
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: 999,
				padding: "0 8px",
				fontSize: 11,
				lineHeight: "18px",
				whiteSpace: "nowrap"
			},
			builtinBadge: {
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-tertiary)",
				border: "1px dashed var(--dsw-alias-border-l3)",
				borderRadius: 999,
				padding: "0 8px",
				fontSize: 11,
				lineHeight: "18px",
				whiteSpace: "nowrap"
			},
			userBadge: {
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground, #fff)",
				borderRadius: 999,
				padding: "0 8px",
				fontSize: 11,
				lineHeight: "18px",
				whiteSpace: "nowrap"
			},
			activeBadge: {
				background: "var(--dsw-alias-state-success-primary)",
				color: "var(--dsw-alias-label-primary-foreground, #fff)",
				borderRadius: 999,
				padding: "0 8px",
				fontSize: 11,
				lineHeight: "18px",
				whiteSpace: "nowrap"
			},
			button: {
				boxSizing: "border-box",
				height: 28,
				font: "inherit",
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-1)",
				borderRadius: 14,
				padding: "0 12px",
				fontSize: 12,
				lineHeight: "26px"
			},
			primary: { border: "none", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground, #fff)" },
			danger: { color: "var(--dsw-alias-state-error-primary)" },
			input: {
				boxSizing: "border-box",
				width: "100%",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				height: 32,
				font: "inherit",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: 8,
				padding: "0 12px",
				fontSize: 14,
				lineHeight: "22px",
				minWidth: 0
			},
			select: {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				height: 32,
				font: "inherit",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: 8,
				padding: "0 10px",
				fontSize: 14,
				lineHeight: "22px"
			},
			fieldLabel: { fontSize: 12, fontWeight: 500, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", margin: 0 },
			textarea: {
				boxSizing: "border-box",
				width: "100%",
				minHeight: 220,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: 8,
				padding: 10,
				fontFamily: "var(--ds-font-family-code, monospace)",
				fontSize: 12,
				lineHeight: 1.5,
				resize: "vertical"
			},
			error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, margin: 0 },
			stage: { display: "flex", alignItems: "center", gap: 8, color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: "4px 0 0" },
			arrow: { color: "var(--dsw-alias-label-tertiary)", fontSize: 16, textAlign: "center", margin: 0 },
			toggleBase: {
				boxSizing: "border-box",
				width: 40,
				height: 22,
				borderRadius: 11,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				position: "relative",
				cursor: "pointer",
				flex: "none",
				padding: 0
			},
			toggleOn: { background: "var(--dsw-alias-button-primary-fill)", borderColor: "transparent" },
			knob: {
				position: "absolute",
				top: 2,
				left: 2,
				width: 16,
				height: 16,
				borderRadius: 8,
				background: "var(--dsw-alias-label-primary-foreground, #fff)",
				transition: "left .12s ease"
			},
			knobOn: { left: 20 }
		};

		function callRpc(call, endpoint, payload) {
			return call(endpoint, payload).then((result) => {
				if (result && result.ok === true) return result.value;
				throw new Error(result && result.error ? result.error.message : "RPC failed");
			});
		}

		function Toggle({ on, onChange, disabled }) {
			return createElement("button", {
				role: "switch",
				"aria-checked": on,
				"aria-label": on ? "关闭此预设" : "启用此预设",
				title: on ? "已启用：切换后下一个模型步骤生效" : "已停用",
				style: { ...styles.toggleBase, ...(on ? styles.toggleOn : {}) },
				onClick: onChange,
				disabled: disabled
			}, createElement("span", { style: { ...styles.knob, ...(on ? styles.knobOn : {}) } }));
		}

		function PresetRow({ preset, active, onToggle, onEdit, onDelete }) {
			const isUser = preset.kind === "user";
			return createElement(
				"div",
				{ style: styles.card },
				createElement(
					"div",
					{ style: styles.row },
					createElement("span", { style: { fontSize: 13, fontWeight: 500 } }, preset.label),
					createElement("span", { style: isUser ? styles.userBadge : styles.builtinBadge }, isUser ? "个性化" : "内置"),
					createElement("span", { style: styles.badge }, preset.name),
					active ? createElement("span", { style: styles.activeBadge }, "当前生效") : null,
					createElement("span", { style: styles.hint }, `${preset.ruleCount} 条规则`)
				),
				preset.description ? createElement("p", { style: styles.hint }, preset.description) : null,
				createElement("p", { style: styles.hint }, preset.path),
				createElement(
					"div",
					{ style: styles.row },
					createElement(Toggle, { on: active, onChange: onToggle }),
					createElement("span", { style: styles.hint }, active ? "已启用" : "未启用"),
					createElement("span", { style: { flex: 1 } }),
					isUser
						? createElement("button", { style: styles.button, onClick: onEdit }, "编辑")
						: createElement("button", { style: styles.button, onClick: onEdit }, "另存为个性化"),
					isUser
						? createElement("button", { style: { ...styles.button, ...styles.danger }, onClick: onDelete }, "删除")
						: null
				)
			);
		}

		// ── 表单化规则编辑器：action / 位置用下拉选择，不手写字段 ──────────────
		const TOP_ORDER = -2000; // 与 host normalizePreset 的置顶哨兵一致
		const RPC_CHANNEL = "/prompt-manager-rpc"; // host 以 webServer prefix 路由挂载同一通道
		const ACTION_OPTIONS = [
			{ value: "insert", label: "插入（新增一段）" },
			{ value: "replace", label: "替换（改写已有段）" },
			{ value: "remove", label: "删除（移除已有段）" }
		];
		const POSITION_OPTIONS_INSERT = [
			{ value: "end", label: "最后（默认）" },
			{ value: "top", label: "置顶 · 压倒一切" },
			{ value: "after", label: "在某段之后…" },
			{ value: "number", label: "指定数值 order…" }
		];
		const POSITION_OPTIONS_REPLACE = [
			{ value: "end", label: "保持原位" },
			{ value: "top", label: "置顶 · 压倒一切" },
			{ value: "number", label: "指定数值 order…" }
		];
		/** 位置选项随动作裁剪：insert 全量；replace 无「在某段之后」（引擎对已有段忽略 after）；remove 无位置概念。 */
		const positionOptionsFor = (action) => {
			if (action === "insert") return POSITION_OPTIONS_INSERT;
			if (action === "replace") return POSITION_OPTIONS_REPLACE;
			return [];
		};
		/** 推断一条规则当前的位置模式（仅编辑态，不落盘）。 */
		const ruleMode = (rule) => {
			if (typeof rule.order === "number" && rule.order <= TOP_ORDER) return "top";
			if (typeof rule.order === "number") return "number";
			if (rule.after !== undefined && rule.after !== null && rule.after !== "") return "after";
			return "end";
		};
		/** 编辑态规则 → 落盘原始规则（mode 只控制字段，不写入）。 */
		const ruleToRaw = (rule) => {
			const raw = { action: rule.action, section: rule.section, text: rule.text };
			const mode = ruleMode(rule);
			if (mode === "top") raw.order = TOP_ORDER;
			else if (mode === "number") raw.order = rule.order;
			else if (mode === "after") raw.after = rule.after;
			return raw;
		};

		// ── 保存校验：字段不完整不允许保存 ────────────────────────────────────
		const SECTION_NAME_RE = /^[a-z][a-z0-9_.:-]*$/;
		/**
		 * 校验规则列表（含预设名）。hard = 阻断保存；soft = 仅提示（目标/锚点
		 * 段暂不在当前组装，可能由插件后续注册）。
		 * @returns [{ index, level: "hard"|"soft", message }]
		 */
		const validateRules = (rules, knownNames, label) => {
			const issues = [];
			const known = new Set(knownNames || []);
			if (!label || String(label).trim() === "") {
				issues.push({ index: -2, level: "hard", message: "预设名称 label 不能为空" });
			}
			if (!Array.isArray(rules) || rules.length === 0) {
				issues.push({ index: -1, level: "hard", message: "至少需要一条规则" });
				return issues;
			}
			rules.forEach((rule, i) => {
				const tag = `规则 ${i + 1}`;
				const section = rule.section === undefined || rule.section === null ? "" : String(rule.section).trim();
				if (section === "") {
					issues.push({ index: i, level: "hard", message: `${tag}：段名不能为空` });
					return;
				}
				if (!SECTION_NAME_RE.test(section)) {
					issues.push({ index: i, level: "hard", message: `${tag}：段名需为小写字母/数字/._:- 组合（如 security:my-guard），当前 "${section}" 不合法` });
					return;
				}
				const mode = ruleMode(rule);
				if (rule.action === "insert") {
					if (known.has(section)) issues.push({ index: i, level: "hard", message: `${tag}：段名 ${section} 已存在，insert 会被静默跳过（请改名，或改用 replace 改写）` });
					if (rule.text === undefined || rule.text === null || String(rule.text).trim() === "") issues.push({ index: i, level: "hard", message: `${tag}：内容 text 不能为空` });
				} else if (rule.action === "replace") {
					if (!known.has(section)) issues.push({ index: i, level: "soft", message: `${tag}：段名 ${section} 不在当前组装中，replace 会退化为插入（若该段由插件后续注册，可忽略）` });
					if (rule.text === undefined || rule.text === null || String(rule.text).trim() === "") issues.push({ index: i, level: "hard", message: `${tag}：内容 text 不能为空` });
				} else if (rule.action === "remove") {
					if (!known.has(section)) issues.push({ index: i, level: "soft", message: `${tag}：段名 ${section} 不在当前组装中，remove 无效（若该段由插件后续注册，可忽略）` });
				}
				if (mode === "after") {
					const after = rule.after === undefined || rule.after === null ? "" : String(rule.after).trim();
					if (after === "") issues.push({ index: i, level: "hard", message: `${tag}：选择了「在某段之后」但未指定锚点段` });
					else if (!known.has(after)) issues.push({ index: i, level: "soft", message: `${tag}：锚点段 ${after} 不在当前组装中，将退化为追加到末尾` });
				} else if (mode === "number") {
					if (typeof rule.order !== "number" || !Number.isFinite(rule.order)) issues.push({ index: i, level: "hard", message: `${tag}：order 数值无效` });
				}
			});
			return issues;
		};

		/** 统一段选择器：下拉选已有段 + 可输入自定义名。规则目标与锚点共用，布局一致。 */		function SectionSelect({ value, knownNames, onChange, placeholder, exclude }) {
			const known = (knownNames || []).filter((n) => n !== exclude);
			const isKnown = known.includes(value);
			return createElement(
				"div",
				{ style: { display: "flex", gap: 6, alignItems: "center", flex: 1, minWidth: 240 } },
				createElement("select", {
					style: { ...styles.select, flex: "none", maxWidth: 160 },
					value: isKnown ? value : "__custom__",
					onChange: (e) => { const v = e.target.value; onChange(v === "__custom__" ? "" : v); }
				}, [
					createElement("option", { key: "__custom__", value: "__custom__" }, "✎ 自定义…"),
					...known.map((n) => createElement("option", { key: n, value: n }, n))
				]),
				createElement("input", {
					style: { ...styles.input, flex: "1 1 auto", width: "auto", minWidth: 120, ...(isKnown ? { opacity: 0.65 } : {}) },
					readOnly: isKnown,
					placeholder: placeholder || "输入段名",
					value: value,
					onChange: (e) => onChange(e.target.value)
				})
			);
		}

		function RuleRow({ rule, index, knownNames, onChange, onRemove }) {
			const mode = ruleMode(rule);
			const isRemove = rule.action === "remove";
			const options = positionOptionsFor(rule.action);
			const field = (label, node) =>
				createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, flex: "none" } },
					createElement("p", { style: styles.fieldLabel }, label), node);
			// 第 1 行：动作 + 目标段（统一选择器）+ 删除
			const row1 = createElement(
				"div",
				{ style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" } },
				field("动作（做什么）", createElement("select", {
					style: styles.select,
					value: rule.action,
					onChange: (e) => onChange({ ...rule, action: e.target.value })
				}, ACTION_OPTIONS.map((o) => createElement("option", { key: o.value, value: o.value }, o.label)))),
				field("段名（对谁做）", createElement(SectionSelect, {
					value: rule.section,
					knownNames,
					onChange: (v) => onChange({ ...rule, section: v }),
					placeholder: isRemove ? "要删除的段名" : (rule.action === "replace" ? "要改写的已有段名" : "新段名（勿与已有段重名）")
				})),
				createElement("button", {
					style: { ...styles.button, ...styles.danger, alignSelf: "flex-end", flex: "none" },
					title: "删除此规则",
					onClick: () => onRemove(index)
				}, "删除")
			);
			// 第 2 行：渲染位置（随动作裁剪；remove 无位置概念）
			const row2 = isRemove ? null : createElement(
				"div",
				{ style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" } },
				field("渲染位置（优先级）", createElement("select", {
					style: styles.select,
					value: mode,
					onChange: (e) => {
						const next = { ...rule };
						delete next.order;
						delete next.after;
						const m = e.target.value;
						if (m === "top") next.order = TOP_ORDER;
						else if (m === "after") next.after = "";
						else if (m === "number") next.order = 0;
						onChange(next);
					}
				}, options.map((o) => createElement("option", { key: o.value, value: o.value }, o.label)))),
				mode === "after"
					? field("锚点段（插在它之后）", createElement(SectionSelect, {
							value: rule.after,
							knownNames,
							exclude: rule.section,
							onChange: (v) => onChange({ ...rule, after: v }),
							placeholder: "选择/输入锚点段"
						}))
					: null,
				mode === "number"
					? field("order 数值（越小越靠前）", createElement("input", {
							style: { ...styles.input, width: 120, minWidth: 90, maxWidth: 120 },
							type: "number",
							step: "any",
							value: rule.order,
							onChange: (e) => onChange({ ...rule, order: Number(e.target.value) })
						}))
					: null
			);
			// 第 3 行：内容
			const row3 = isRemove
				? createElement("p", { style: styles.hint }, "删除动作不需要文本：将移除同名段（若存在）。")
				: field("内容 text", createElement("textarea", {
						style: { ...styles.textarea, minHeight: 60, maxHeight: 140 },
						placeholder: "此段在系统提示词中的文本（{{variable}} 会插值）",
						value: rule.text,
						onChange: (e) => onChange({ ...rule, text: e.target.value })
					}));
			return createElement(
				"div",
				{ style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8, background: "var(--dsw-alias-bg-module-platform)" } },
				row1,
				row2,
				row3
			);
		}

		/** 实时渲染预览：把草稿规则应用到当前基础组装，预测各段落位；自定义段可拖拽调整顺序。 */
		function DraftPreview({ call, overrides, onReorder }) {
			// 未填段名的规则视为未完成，不参与预览
			const complete = (overrides || []).filter((r) => r.section && String(r.section).trim() !== "");
			const [state, setState] = useState({ loading: false, data: null, error: null });
			const [dragOver, setDragOver] = useState(-1); // 槽位：放在 applied[dragOver] 之前；-1 = 无
			useEffect(() => {
				let alive = true;
				if (complete.length === 0) {
					setState({ loading: false, data: null, error: null });
					return () => { alive = false; };
				}
				const timer = setTimeout(() => {
					setState((s) => ({ ...s, loading: true, error: null }));
					callRpc(call, "previewPreset", { overrides: complete })
						.then((data) => { if (alive) setState({ loading: false, data, error: null }); })
						.catch((e) => { if (alive) setState({ loading: false, data: null, error: String(e && e.message ? e.message : e) }); });
				}, 250);
				return () => { alive = false; clearTimeout(timer); };
			}, [call, JSON.stringify(complete)]);

			/** 放到槽位 slot（applied[slot] 之前）。取邻居段的真实 key 算中点 order。 */
			const handleDrop = (e, slot) => {
				e.preventDefault();
				const name = e.dataTransfer ? String(e.dataTransfer.getData("text/plain") || "") : "";
				const applied = state.data ? state.data.applied : [];
				setDragOver(-1);
				if (!name || applied.length === 0) return;
				const prev = slot > 0 ? applied[slot - 1] : null;
				const next = slot < applied.length ? applied[slot] : null;
				const keyOf = (s) => (typeof s.key === "number" ? s.key : s.position - 1); // host 未升级时回退
				let order;
				if (prev === null) order = TOP_ORDER;            // 拖到最前 = 置顶（压倒一切）
				else if (next === null) order = keyOf(prev) + 1; // 拖到最后
				else order = (keyOf(prev) + keyOf(next)) / 2;    // 中点：精确落在两者之间
				if (onReorder) onReorder(name, order);
			};

			const rows = [];
			if (state.error) {
				rows.push(createElement("p", { style: styles.error }, `预览不可用：${state.error}`));
				rows.push(createElement("p", { style: styles.hint }, "保存并启用预设后，可在「全屏查看幕布」看到完整渲染流水线。"));
			} else if (state.data) {
				const draftCount = state.data.draftCount || 0;
				const removedCount = state.data.removedCount || 0;
				rows.push(createElement(
					"p",
					{ style: styles.hint },
					draftCount > 0
						? `按当前草稿：${draftCount} 个自定义段将生效，预测落位如下（与模型实际收到的一致）。`
						: "当前草稿没有新增/替换段。",
					removedCount > 0 ? createElement("span", {}, ` 另有 ${removedCount} 个段将被移除。`) : null
				));
				// 空文本段：applyPreset 会显示它，但 renderPrompt 渲染时丢弃——预览里要明示
				const textBySection = new Map(complete.map((r) => [r.section, String(r.text || "").trim()]));
				const list = state.data.applied.map((s, idx) =>
					createElement(
						"div",
						{
							key: s.name,
							draggable: !!s.draft,
							title: s.draft ? "拖动调整渲染位置" : undefined,
							onDragStart: (e) => {
								if (!s.draft) { e.preventDefault(); return; }
								e.dataTransfer.setData("text/plain", s.name);
								e.dataTransfer.effectAllowed = "move";
							},
							onDragOver: (e) => { e.preventDefault(); if (dragOver !== idx) setDragOver(idx); },
							onDragLeave: () => { if (dragOver === idx) setDragOver(-1); },
							onDrop: (e) => handleDrop(e, idx),
							onDragEnd: () => setDragOver(-1),
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								padding: "3px 6px",
								cursor: s.draft ? "grab" : "default",
								...(s.draft ? { background: "rgba(59,130,246,.10)", borderRadius: 6 } : {}),
								...(dragOver === idx ? { borderTop: "2px solid #3b82f6" } : {})
							}
						},
						createElement("span", { style: { ...styles.badge, ...(s.draft ? { borderColor: "#3b82f6", color: "#8ab4f8" } : {}) } }, `#${s.position}`),
						createElement("span", { style: { fontFamily: "var(--ds-font-family-code, monospace)", fontSize: 12, color: "var(--dsw-alias-label-primary)", fontWeight: s.draft ? 600 : 400 } }, s.name),
						s.draft ? createElement("span", { style: { ...styles.badge, background: "#16233a", color: "#8ab4f8", border: "1px solid #3b82f6" } }, "自定义 · 可拖动") : null,
						s.draft && (textBySection.get(s.name) || "") === ""
							? createElement("span", { style: { ...styles.badge, color: "#ef6a6a", border: "1px solid #6b2f36" } }, "空文本 · 不会渲染")
							: null,
						s.removed ? createElement("span", { style: { ...styles.badge, color: "#ef6a6a", border: "1px solid #6b2f36" } }, "将移除") : null
					)
				);
				rows.push(createElement("div", { style: { maxHeight: 240, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 } }, ...list));
				// 底部追加区（拖到最末尾）
				rows.push(createElement("div", {
					onDragOver: (e) => { e.preventDefault(); if (dragOver !== state.data.applied.length) setDragOver(state.data.applied.length); },
					onDragLeave: () => { if (dragOver === state.data.applied.length) setDragOver(-1); },
					onDrop: (e) => handleDrop(e, state.data.applied.length),
					style: { height: 20, borderRadius: 6, ...(dragOver === state.data.applied.length ? { borderTop: "2px solid #3b82f6" } : {}) }
				}));
				rows.push(createElement("p", { style: styles.hint }, "拖动蓝色「自定义」行即可调整其在系统提示词中的顺序（自动换算成 order/置顶），拖完预览立即更新，保存后生效。"));
				rows.push(createElement(
					"p",
					{ style: styles.hint },
					"预览只应用草稿规则，未保存。保存并启用后，幕布（设置 → 提示词管理 → 全屏查看幕布）的覆盖列与来源段状态会随之更新。"
				));
			} else {
				rows.push(createElement("p", { style: styles.hint }, state.loading ? "计算落位中…" : ""));
			}
			return createElement(
				"div",
				{ style: { border: "1px dashed var(--dsw-alias-border-l3)", borderRadius: 10, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 } },
				createElement("p", { style: { ...styles.title, margin: 0 } }, "渲染流水线预览"),
				...rows
			);
		}

		function PromptManagerSection({ call }) {
			const [presets, setPresets] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);
			const [newName, setNewName] = useState("");
			const [editing, setEditing] = useState(null); // { name, label, description, rules, yamlMode, yaml }
			const [knownNames, setKnownNames] = useState([]);

			const loadAll = useCallback(() => {
				setBusy(true);
				setError(null);
				return callRpc(call, "listPresets", {})
					.then((p) => { setPresets(p); setBusy(false); })
					.catch((e) => { setError(String(e && e.message ? e.message : e)); setBusy(false); });
			}, [call]);

			useEffect(() => { void loadAll(); }, [loadAll]);

			const run = useCallback((action) => {
				setBusy(true);
				setError(null);
				return action()
					.then(() => { void loadAll(); })
					.catch((e) => { setError(String(e && e.message ? e.message : e)); setBusy(false); });
			}, [loadAll]);

			const toggle = (name, active) => run(() => callRpc(call, "setActive", { name: active ? "" : name }));
			const remove = (name) => run(() => callRpc(call, "deletePreset", { name }));
			const create = () => {
				const name = newName.trim();
				if (!name) return;
				if (presets && presets.presets.some((p) => p.name === name)) {
					setError(`预设 ${name} 已存在，请换一个名字`);
					return;
				}
				setNewName("");
				// 新建 = 打开"新预设草稿"编辑器，**不立即创建文件**；
				// 保存时才原子创建（createPreset 带完整字段），字段不完整保存被
				// 校验拦截 → 空预设根本不会产生。
				void callRpc(call, "getPipeline", {}).catch(() => null)
					.then((pipeline) => {
						const names = [];
						const seen = new Set();
						const push = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
						if (pipeline) {
							(pipeline.stages?.source || []).forEach((s) => push(s.name));
							(pipeline.stages?.interpolated || []).forEach((s) => push(s.name));
						}
						setKnownNames(names);
						setEditing({ name, label: name, description: "", rules: [], yamlMode: false, yaml: null, isNew: true });
					})
					.catch((e) => setError(String(e && e.message ? e.message : e)));
			};
			const openEditor = (name) => {
				// 结构化读取：host 已用 js-yaml 解析好，浏览器端不解析 YAML
				void Promise.all([
					callRpc(call, "getPreset", { name }),
					callRpc(call, "getPipeline", {}).catch(() => null)
				])
					.then(([preset, pipeline]) => {
						if (preset === null || preset === undefined) throw new Error(`预设 ${name} 不存在`);
						const rules = (preset.overrides || []).map((r) => ({
							action: r.action,
							section: r.section,
							text: r.text,
							order: r.order,
							after: r.after
						}));
						const names = [];
						const seen = new Set();
						const push = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
						if (pipeline) {
							(pipeline.stages?.source || []).forEach((s) => push(s.name));
							(pipeline.stages?.interpolated || []).forEach((s) => push(s.name));
						}
						setKnownNames(names);
						setEditing({ name: preset.name, label: preset.label, description: preset.description || "", rules, yamlMode: false, yaml: null, isNew: false });
					})
					.catch((e) => setError(String(e && e.message ? e.message : e)));
			};
			const saveEditor = () => {
				if (!editing) return;
				const overrides = editing.rules.map(ruleToRaw);
				const { name, label, description, isNew } = editing;
				setEditing(null);
				// 新预设：保存时才原子创建（createPreset 带完整字段，且拒绝覆盖已存在
				// 的同名预设）；已有预设：updatePreset 更新。字段不完整时保存按钮已禁用。
				const action = isNew
					? callRpc(call, "createPreset", { name, label, description, overrides })
					: callRpc(call, "updatePreset", { name, label, description, overrides });
				void run(() => action);
			};
			const addRule = () => {
				if (!editing) return;
				const rules = [...editing.rules, { action: "insert", section: "", text: "", order: undefined, after: undefined }];
				setEditing({ ...editing, rules });
			};
			const updateRule = (index, rule) => {
				if (!editing) return;
				const rules = editing.rules.map((r, i) => (i === index ? rule : r));
				setEditing({ ...editing, rules });
			};
			const removeRule = (index) => {
				if (!editing) return;
				const rules = editing.rules.filter((_, i) => i !== index);
				setEditing({ ...editing, rules });
			};
			const reorderRule = (sectionName, order) => {
				if (!editing) return;
				// 拖拽落位：写入 order 并清掉 after（order 优先），预览立即重算
				const rules = editing.rules.map((r) => (r.section === sectionName ? { ...r, order, after: undefined } : r));
				setEditing({ ...editing, rules });
			};
			const toggleYamlMode = () => {
				if (!editing) return;
				if (editing.isNew) {
					// 新预设尚未落盘，无 YAML 可读；先保存再切 YAML 编辑
					setError("新预设请先保存（字段补全后），再切换到「原始 YAML」编辑");
					return;
				}
				if (!editing.yamlMode) {
					// 切到 YAML：拉取原始文件文本
					void callRpc(call, "getPresetYaml", { name: editing.name })
						.then((yaml) => setEditing({ ...editing, yamlMode: true, yaml }))
						.catch((e) => setError(String(e && e.message ? e.message : e)));
				} else {
					setEditing({ ...editing, yamlMode: false });
				}
			};
			const saveYamlEditor = () => {
				if (!editing || !editing.yamlMode) return;
				const name = editing.name;
				setEditing(null);
				void run(() => callRpc(call, "updatePresetYaml", { name, yaml: editing.yaml }));
			};

			const children = [];
			children.push(createElement("h3", { style: styles.title }, "提示词管理"));

			if (error) children.push(createElement("p", { style: styles.error }, `错误：${error}`));

			// 幕布入口（全屏独立页面）——设置页唯一入口，提示词聚合视图全部在画布
			children.push(createElement(
				"div",
				{ style: styles.card },
				createElement(
					"div",
					{ style: styles.row },
					createElement("h4", { style: { ...styles.title, margin: 0 } }, "组装流水线（幕布）"),
					createElement("span", { style: { flex: 1 } }),
					createElement("button", { style: { ...styles.button, ...styles.primary }, onClick: () => { window.open("/prompt-manager/pipeline", "_blank"); } }, "全屏查看幕布")
				),
				createElement("p", { style: styles.hint }, "以画布流程图查看最终发送提示词的构造过程（来源片段 → 预设覆盖 → 变量插值 → 最终渲染），在新页面全屏展示。")
			));

			// Presets（所有视图共用）
			children.push(createElement("h4", { style: styles.title }, "预设方案"));
			children.push(
				createElement(
					"div",
					{ style: styles.card },
					createElement("p", { style: styles.hint }, "「提示词预设」只决定系统提示词内容，与「Agent 预设」（会话工具/插件组合）是两套独立机制。内置预设随插件分发（只读）；个性化预设默认关闭，用开关启用后下一个模型步骤生效。"),
					presets !== null
						? createElement("p", { style: styles.hint }, `个性化预设目录：${presets.storeRoot}　|　激活指针：${presets.activePath}`)
						: null,
					presets === null
						? createElement("p", { style: styles.hint }, busy ? "加载中…" : "无预设")
						: createElement(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: 8 } },
								presets.presets.length === 0
									? createElement("p", { style: styles.hint }, "暂无预设。可新建个性化预设，或使用 save_prompt 工具固化优化后的提示词。")
									: presets.presets.map((preset) =>
											createElement(PresetRow, {
												key: preset.name,
												preset,
												active: preset.name === presets.active,
												onToggle: () => toggle(preset.name, preset.name === presets.active),
												onEdit: () => openEditor(preset.name),
												onDelete: () => remove(preset.name)
											})
										),
								createElement(
									"div",
									{ style: styles.row },
									createElement("input", {
										style: styles.input,
										value: newName,
										placeholder: "新个性化预设名（小写字母/数字/-/_）",
										onChange: (e) => setNewName(e.target.value),
										onKeyDown: (e) => { if (e.key === "Enter") create(); }
									}),
									createElement("button", { style: { ...styles.button, ...styles.primary }, onClick: create, disabled: busy }, "新建"),
									createElement("button", { style: styles.button, onClick: () => { void loadAll(); }, disabled: busy }, "刷新")
								)
							)
				)
			);

			// Editor（表单优先；YAML 作为高级模式保留）
			if (editing) {
				const draftOverrides = editing.yamlMode ? [] : editing.rules.map(ruleToRaw);
				const issues = editing.yamlMode ? [] : validateRules(editing.rules, knownNames, editing.label);
				const hardIssues = issues.filter((i) => i.level === "hard");
				const softIssues = issues.filter((i) => i.level === "soft");
				children.push(
					createElement(
						"div",
						{ style: styles.card },
						createElement("h4", { style: styles.title }, `${editing.isNew ? "新建预设" : "编辑预设"} ${editing.name}${editing.isNew ? "（草稿）" : ""}`),
						createElement(
							"div",
							{ style: styles.row },
							createElement("button", { style: { ...styles.button, ...(editing.yamlMode ? {} : styles.primary) }, onClick: () => setEditing({ ...editing, yamlMode: false }) }, "表单编辑"),
							createElement("button", {
								style: { ...styles.button, ...(editing.yamlMode ? styles.primary : {}) },
								onClick: toggleYamlMode,
								disabled: editing.isNew,
								title: editing.isNew ? "新预设尚未落盘，先保存再切 YAML" : undefined
							}, "原始 YAML"),
							createElement("span", { style: { flex: 1 } }),
							createElement("button", {
								style: styles.button,
								title: "用当前草稿规则打开幕布，预览自定义节点在渲染流水线中的落位",
								onClick: () => {
									const complete = draftOverrides.filter((r) => r.section && String(r.section).trim() !== "");
									// 带上预设名：画布草稿保存直接写入该预设，无需再手输目标名
									const url = complete.length > 0
										? "/prompt-manager/pipeline?draft=" + encodeURIComponent(JSON.stringify(complete)) + "&preset=" + encodeURIComponent(editing.name)
										: "/prompt-manager/pipeline";
									window.open(url, "_blank");
								}
							}, "在幕布中预览草稿")
						),
						editing.yamlMode
							? createElement(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: 8 } },
									createElement("p", { style: styles.hint }, "YAML 格式：label / description / overrides（action: replace|insert|remove, section, text, order?, after?, top?）。替换文本中的 {{variable}} 会正常插值。"),
									createElement("textarea", {
										style: styles.textarea,
										value: editing.yaml,
										onChange: (e) => setEditing({ ...editing, yaml: e.target.value })
									}),
									createElement(
										"div",
										{ style: styles.row },
										createElement("button", { style: { ...styles.button, ...styles.primary }, onClick: saveYamlEditor, disabled: busy }, "保存 YAML"),
										createElement("button", { style: styles.button, onClick: () => setEditing(null) }, "取消")
									)
								)
							: createElement(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: 8 } },
									editing.isNew
										? createElement("p", { style: styles.hint }, "新预设草稿：保存（字段完整）后才创建预设文件；取消不会产生空预设。")
										: null,
									createElement(
										"div",
										{ style: styles.row },
										createElement(
											"div",
											{ style: { display: "flex", flexDirection: "column", gap: 6, flex: 1 } },
											createElement("p", { style: styles.fieldLabel }, "预设名称 label"),
											createElement("input", {
												style: styles.input,
												value: editing.label,
												onChange: (e) => setEditing({ ...editing, label: e.target.value })
											})
										),
										createElement(
											"div",
											{ style: { display: "flex", flexDirection: "column", gap: 6, flex: 2 } },
											createElement("p", { style: styles.fieldLabel }, "描述 description"),
											createElement("input", {
												style: styles.input,
												value: editing.description,
												onChange: (e) => setEditing({ ...editing, description: e.target.value })
											})
										)
									),
									createElement("p", { style: styles.hint }, "一条规则 = 动作（做什么）+ 段名（对谁做）+ 渲染位置（放哪，即优先级）+ 内容。位置随动作裁剪：「置顶」把该段排到 harness:identity 之前（压倒一切）；替换动作默认保持原位；删除与位置无关。"),
									editing.rules.length === 0
										? createElement("p", { style: styles.hint }, "暂无规则。点「添加规则」新增一条。")
										: editing.rules.map((rule, index) =>
												createElement(RuleRow, {
													key: index,
													rule,
													index,
													knownNames,
													onChange: (next) => updateRule(index, next),
													onRemove: removeRule
												})
											),
									createElement("button", { style: { ...styles.button, ...styles.primary }, onClick: addRule }, "＋ 添加规则"),
									createElement(DraftPreview, { call, overrides: draftOverrides, onReorder: reorderRule }),
									hardIssues.length > 0
										? createElement(
												"div",
												{ style: { border: "1px solid var(--dsw-alias-state-error-primary)", borderRadius: 10, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 } },
												createElement("p", { style: { ...styles.title, margin: 0, color: "var(--dsw-alias-state-error-primary)" } }, "字段未完整，无法保存："),
												hardIssues.map((issue, i) => createElement("p", { key: i, style: styles.error }, `• ${issue.message}`))
											)
										: null,
									softIssues.length > 0
										? createElement(
												"div",
												{ style: { border: "1px dashed var(--dsw-alias-border-l3)", borderRadius: 10, padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 } },
												softIssues.map((issue, i) => createElement("p", { key: i, style: { ...styles.hint, color: "var(--dsw-alias-state-warn-label)" } }, `• ${issue.message}`))
											)
										: null,
									createElement(
										"div",
										{ style: styles.row },
										createElement("button", {
											style: { ...styles.button, ...styles.primary },
											onClick: saveEditor,
											disabled: busy || hardIssues.length > 0,
											title: hardIssues.length > 0 ? "请先补全字段（见上方红色提示）" : undefined
										}, "保存"),
										createElement("button", { style: styles.button, onClick: () => setEditing(null) }, "取消")
									)
								)
					)
				);
			}

			// 提示词聚合视图（来源分段 / 渲染结果）已从设置页移除——见
			// docs/DESIGN.md §15.5f：设置页内嵌视图使用全局组装（scope=global，
			// 变量缺失、工具段缺失），与模型实际收到的 agent 组装不一致，
			// 属误导性视图；画布（/prompt-manager/pipeline）是唯一权威视图。

			return createElement("div", { style: styles.root }, ...children);
		}

		/** Browser plugin body: mount the settings section. */
		function apply(ctx) {
			// slots.inject waits for the settings shell to declare the
			// settings.section slot, then registers; the registration disposes
			// automatically with this fiber.
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "prompt-manager",
				order: 25,
				label: () => "提示词管理",
				inject: () => ({
					call: (endpoint, payload) => ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload)
				})
			}, PromptManagerSection));
		}

		/** Required services (cordis fiber inject — service names, not package names).
		 *  `slots` is provided by the client runtime shell, `connection` by
		 *  @deepseek-ai/dsh-client-connection; the package-name list in package.json
		 *  `dsh.client.inject` only drives client-module loading, not fiber inject. */
		const inject = ["slots", "connection"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
