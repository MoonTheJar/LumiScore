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
.ex-preview__head{display:flex;align-items:center;gap:8px}
.ex-refresh{margin-left:auto;font:inherit;font-size:11px;font-weight:600;padding:3px 10px;border:1px solid var(--sh-border);
  border-radius:99px;background:var(--sh-surface-2);color:var(--sh-muted);cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.ex-refresh:hover{color:var(--sh-text);border-color:var(--sh-accent)}
.ex-refresh--dirty{color:var(--sh-accent);border-color:var(--sh-accent);background:var(--sh-accent-soft);animation:ex-refresh-pulse 1.2s ease-in-out infinite}
@keyframes ex-refresh-pulse{0%,100%{opacity:1}50%{opacity:.55}}
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
.ex-wip{margin-bottom:2px;padding:8px 12px;border-radius:9px;font-size:11.5px;line-height:1.6;
  color:var(--sh-accent);background:color-mix(in srgb,var(--sh-accent) 10%,transparent);
  border:1px solid color-mix(in srgb,var(--sh-accent) 35%,transparent)}
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

/* ── 0.1.6：图片导出（位图 / 矢量）新增控件 ── */
.ex-seg{display:flex;gap:6px;padding:4px;border:1px solid var(--sh-border);border-radius:10px;
  background:var(--sh-surface-2)}
.ex-seg__btn{flex:1;padding:7px 10px;border:1px solid transparent;border-radius:7px;
  background:transparent;color:var(--sh-muted);font:inherit;font-size:12.5px;cursor:pointer;transition:all .12s}
.ex-seg__btn:hover{color:var(--sh-text)}
.ex-seg__btn--on{background:var(--sh-accent);border-color:var(--sh-accent);color:#fff;font-weight:600}
.ex-color{display:flex}
.ex-color input[type=color]{width:38px;height:30px;padding:2px;border:1px solid var(--sh-border);
  border-radius:7px;background:var(--sh-surface-2);cursor:pointer}
.ex-num{width:100%;height:32px;padding:0 9px;border:1px solid var(--sh-border);border-radius:8px;
  background:var(--sh-surface-2);color:var(--sh-text);font:inherit;font-size:13px}
.ex-lightbox{position:fixed;inset:0;z-index:1500;display:flex;align-items:center;justify-content:center;
  padding:32px;background:rgba(0,0,0,.82);cursor:zoom-out;animation:ex-fade .15s ease}
.ex-lightbox__img{max-width:92vw;max-height:88vh;object-fit:contain;border-radius:8px;
  box-shadow:0 20px 60px rgba(0,0,0,.5);cursor:default}
.ex-lightbox__close{position:absolute;top:18px;right:22px;width:38px;height:38px;display:flex;
  align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,.12);
  color:#fff;font-size:22px;line-height:1;cursor:pointer;user-select:none;transition:background .12s}
.ex-lightbox__close:hover{background:rgba(255,255,255,.25)}
@keyframes ex-fade{from{opacity:0}to{opacity:1}}
`
