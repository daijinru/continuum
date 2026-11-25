import React, { useState } from "react";
import { api } from "./lib.tsx";

export function ProjectFolder({ canChoose }: { canChoose: boolean }) {
  const [path, setPath] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <label>
        项目目录的绝对路径
        <input
          name="path"
          required
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/…/project"
        />
      </label>
      {canChoose && (
        <button
          type="button"
          disabled={choosing}
          onClick={async () => {
            setChoosing(true);
            setError("");
            try {
              const chosen = await api("/workspaces/choose-folder", {});
              if (chosen.path) setPath(chosen.path);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setChoosing(false);
            }
          }}
        >
          选择文件夹…
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
