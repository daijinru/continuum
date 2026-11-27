import React, { useRef, useState } from "react";

import { createPortal } from "react-dom";

export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState<string>();
  if (failed === src)
    return <span role="status">{alt}（无法预览，请检查原文件）</span>;
  return (
    <>
      <button
        type="button"
        className="image-preview"
        aria-label={"查看原图：" + alt}
        onClick={() => dialog.current?.showModal()}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(src)}
        />
      </button>
      {createPortal(
        <dialog ref={dialog} className="image-dialog" aria-label={alt}>
          <button
            type="button"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
          <img src={src} alt={alt} loading="lazy" />
        </dialog>,
        document.body,
      )}
    </>
  );
}
