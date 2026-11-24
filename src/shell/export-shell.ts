// 导出弹窗的共用外壳：第五页媒体导出（3dpreview/export-modal）与二/三/五页工程导出
// （shell/project-export）此前各自手搭同一套 .ex-modal DOM，现统一到这一份。
// 只负责 chrome（遮罩/卡片/标题栏/关闭钮/底栏进度+取消+导出），内容与 close 逻辑各自保留。
import { EXPORT_CSS } from "./export-css";
import { t } from "./i18n";

/** 建一个带类名的元素（两份导出弹窗的内容 DOM 也共用它） */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
): HTMLElementTagNameMap[K] {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	return n;
}

export interface ExportShell {
	wrap: HTMLDivElement;
	body: HTMLDivElement;
	closeBtn: HTMLButtonElement;
	cancelBtn: HTMLButtonElement;
	exportBtn: HTMLButtonElement;
	progWrap: HTMLDivElement;
	progFill: HTMLDivElement;
	progNote: HTMLDivElement;
}

/** 搭好 .ex-modal 外壳并返回各节点；body 留空，调用方往里 append 左右栏。 */
export function buildExportShell(): ExportShell {
	const wrap = h("div", "ex-modal");
	wrap.setAttribute("role", "dialog");
	wrap.setAttribute("aria-modal", "true");
	wrap.innerHTML = `<style>${EXPORT_CSS}</style>`;

	const card = h("div", "ex-card");
	const head = h("div", "ex-head");
	const title = h("strong", "ex-title");
	title.textContent = t("ex.export");
	const closeBtn = h("button", "sh-icon-btn");
	closeBtn.type = "button";
	closeBtn.textContent = "×";
	closeBtn.setAttribute("aria-label", t("ex.close"));
	head.append(title, h("div", "sh-spacer"), closeBtn);

	const body = h("div", "ex-body");

	const foot = h("div", "ex-foot");
	const progWrap = h("div", "ex-prog");
	progWrap.hidden = true;
	const progBar = h("div", "ex-prog__bar");
	const progFill = h("div", "ex-prog__fill");
	progBar.append(progFill);
	const progNote = h("div", "ex-prog__note");
	progWrap.append(progBar, progNote);
	const cancelBtn = h("button", "sh-btn");
	cancelBtn.type = "button";
	cancelBtn.textContent = t("confirm.cancel");
	const exportBtn = h("button", "sh-btn sh-btn--primary");
	exportBtn.type = "button";
	exportBtn.textContent = t("ex.export");
	foot.append(progWrap, h("div", "sh-spacer"), cancelBtn, exportBtn);

	card.append(head, body, foot);
	wrap.append(card);

	return {
		wrap,
		body,
		closeBtn,
		cancelBtn,
		exportBtn,
		progWrap,
		progFill,
		progNote,
	};
}
