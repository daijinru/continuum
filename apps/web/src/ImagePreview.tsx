import React, { useRef } from "react";

export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className="image-preview"
        aria-label={"查看原图：" + alt}
        onClick={() => dialog.current?.showModal()}
      >
        <img src={src} alt={alt} loading="lazy" />
      </button>
      <dialog ref={dialog} className="image-dialog" aria-label={alt}>
        <button type="button" autoFocus onClick={() => dialog.current?.close()}>
          关闭
        </button>
        <img src={src} alt={alt} loading="lazy" />
      </dialog>
    </>
  );
}
