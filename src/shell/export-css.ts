// 导出弹窗共用样式：第五页（3D 导出）与第二/三页（工程文件导出）同用一套 .ex-* 类，
// 保证「观感一致」。样式随弹窗内联注入，避免全局污染。
export const EXPORT_CSS = `
.ex-modal{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;
  padding:24px;background:color-mix(in srgb,var(--sh-bg,#0b0d13) 62%,transparent);backdrop-filter:blur(3px)}
.ex-modal[hidden]{display:none}
.ex-card{width:min(860px,96vw);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
  background:var(--sh-surface);border:1px solid var(--sh-border);border-radius:var(--sh-r-lg,14px);
  box-shadow:var(--sh-shadow-2,0 18px 60px rgba(0,0,0,.35))}
.ex-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--sh-border)}
.ex-title{font-size:15px;font-weight:650}
.ex-body{flex:1;display:flex;min-height:0;overflow:hidden}
.ex-left{width:270px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;padding:14px;
  border-right:1px solid var(--sh-border);background:var(--sh-surface-2);overflow-y:auto}
.ex-right{flex:1;min-width:0;overflow-y:auto;padding:16px 18px}
.ex-right--busy{opacity:.6;pointer-events:none}
.ex-sec-label{font-size:11px;font-weight:650;letter-spacing:.05em;color:var(--sh-faint);
  text-transform:uppercase;margin:4px 0 2px}
.ex-left .ex-sec-label:first-child{margin-top:0}
.ex-kinds{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.ex-kind{display:flex;align-items:center;gap:10px;padding:10px 12px;text-align:left;
  border:1px solid var(--sh-border);border-radius:10px;background:var(--sh-surface);
  color:var(--sh-text);font:inherit;font-size:13.5px;cursor:pointer;transition:all .12s}
.ex-kind:hover{border-color:var(--sh-accent)}
.ex-kind--on{border-color:var(--sh-accent);background:var(--sh-accent-soft,color-mix(in srgb,var(--sh-accent) 12%,transparent));
  color:var(--sh-accent);font-weight:650}
.ex-kind--off{opacity:.45;cursor:not-allowed}
.ex-kind--off:hover{border-color:var(--sh-border)}
.ex-kind__icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;
  background:var(--sh-surface-2);border:1px solid var(--sh-border)}
.ex-kind--on .ex-kind__icon{background:var(--sh-surface);color:var(--sh-accent)}
.ex-kind__tag{margin-left:auto;font-size:10.5px;font-weight:600;color:var(--sh-faint);
  border:1px solid var(--sh-border);border-radius:99px;padding:1px 7px}
.ex-desc{font-size:12px;line-height:1.7;color:var(--sh-muted);margin-bottom:8px}
.ex-preview{position:relative;aspect-ratio:16/9;border:1px solid var(--sh-border);border-radius:10px;
  overflow:hidden;background:var(--sh-bg);display:flex;align-items:center;justify-content:center}
.ex-preview__img{width:100%;height:100%;object-fit:cover;display:block}
.ex-preview__ph{color:var(--sh-faint);font-size:12px;padding:0 12px;text-align:center}
.ex-form{display:flex;flex-direction:column;gap:8px}
.ex-row{display:grid;grid-template-columns:88px 1fr;align-items:center;gap:12px}
.ex-row__label{color:var(--sh-muted);font-size:13px}
.ex-select{width:100%;height:34px;padding:0 10px;border:1px solid var(--sh-border);border-radius:8px;
  background:var(--sh-surface-2);color:var(--sh-text);font:inherit;font-size:13px}
.ex-form .ex-sec-label{margin-top:10px}
.ex-form .ex-sec-label:first-child{margin-top:0}
.ex-check{display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid var(--sh-border);
  border-radius:9px;background:var(--sh-surface-2);font-size:13px;color:var(--sh-text);cursor:pointer}
.ex-check input{width:16px;height:16px;accent-color:var(--sh-accent)}
.ex-check--off{opacity:.45;cursor:not-allowed}
.ex-note{margin-top:8px;padding:9px 11px;border-radius:9px;font-size:11.5px;line-height:1.65;
  color:var(--sh-faint);background:var(--sh-surface-2);border:1px solid var(--sh-border)}
.ex-foot{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--sh-border)}
.ex-prog{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.ex-prog__bar{height:7px;border-radius:99px;background:var(--sh-surface-2);overflow:hidden}
.ex-prog__fill{height:100%;width:0%;border-radius:99px;background:var(--sh-accent);transition:width .15s}
.ex-prog__note{font-size:11.5px;color:var(--sh-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:680px){
  /* 竖排时改成整块一个滚动条：左栏原本 flex-shrink:0，竖排后会把右栏挤到只剩几十像素，
     两个嵌套滚动区在触屏上也很难用 */
  .ex-body{flex-direction:column;overflow-y:auto;overscroll-behavior:contain}
  .ex-left{width:auto;flex:0 0 auto;border-right:0;border-bottom:1px solid var(--sh-border);overflow:visible}
  .ex-right{flex:0 0 auto;overflow:visible}
  .ex-preview{max-width:240px}
}
`
