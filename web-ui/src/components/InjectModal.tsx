import { useState, useEffect } from "react"
import { wsClient } from "../ws/client"
import styles from "./InjectModal.module.css"

export function InjectModal() {
  const [open, setOpen]     = useState(false)
  const [prompt, setPrompt] = useState("")

  useEffect(() => {
    const handler = () => setOpen(true)
    document.addEventListener("swarm:open-inject", handler)
    return () => document.removeEventListener("swarm:open-inject", handler)
  }, [])

  function close() { setOpen(false); setPrompt("") }

  function submit() {
    const p = prompt.trim()
    if (!p) return
    wsClient.send({ type: "inject", tabId: "", prompt: p })
    close()
  }

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className={styles.box}>
        <h3>⊕ Inject Task</h3>
        <textarea
          className={styles.textarea}
          placeholder="Describe what you want the agent to do…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") close() }}
          autoFocus
        />
        <div className={styles.btns}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-resume" onClick={submit}>Inject</button>
        </div>
      </div>
    </div>
  )
}
