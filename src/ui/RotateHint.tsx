import { createEffect, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { t } from "../i18n";

// Portrait + coarse-pointer (touch) devices get a small, dismissible strip
// recommending landscape, where the falling-notes area has room and the keys
// aren't squashed into a corner. Hidden on desktop and in landscape, and after
// the user dismisses it (remembered across sessions).
const STORAGE_KEY = "midee.rotateHintDismissed";

interface RotateHintProps {
  isDismissed: () => boolean
  isPortrait: () => boolean
  isCoarse: () => boolean
  onDismiss: () => void
}

function RotateHintView(props: RotateHintProps) {
  const shown = (): boolean =>
    props.isPortrait() && props.isCoarse() && !props.isDismissed();

  return (
    <div
      class="rotate-hint"
      role="status"
      classList={{ "rotate-hint--shown": shown() }}
    >
      <svg
        class="rotate-hint-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      <span class="rotate-hint-text">{t("mobile.rotateHint")}</span>
      <button
        type="button"
        class="rotate-hint-close"
        onClick={props.onDismiss}
        aria-label={t("mobile.rotateHintDismiss")}
      >
        ×
      </button>
    </div>
  );
}

export function mountRotateHint(): () => void {
  const el = document.createElement("div");
  document.body.appendChild(el);

  const isCoarse = () => window.matchMedia("(pointer: coarse)").matches;
  const [dismissed, setDismissed] = createSignal(
    localStorage.getItem(STORAGE_KEY) === "1",
  );
  const [portrait, setPortrait] = createSignal(
    window.matchMedia("(orientation: portrait)").matches,
  );

  // Follow rotation/orientation changes (and viewport switches that flip it).
  createEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = (): void => {
      setPortrait(mq.matches);
    };
    onChange();
    mq.addEventListener("change", onChange);
    onCleanup(() => mq.removeEventListener("change", onChange));
  });

  const onDismiss = (): void => {
    setDismissed(true);
    localStorage.setItem(STORAGE_KEY, "1");
  };

  const dispose = render(
    () => (
      <RotateHintView
        isDismissed={dismissed}
        isPortrait={portrait}
        isCoarse={isCoarse}
        onDismiss={onDismiss}
      />
    ),
    el,
  );

  return () => {
    dispose();
    el.remove();
  };
}
