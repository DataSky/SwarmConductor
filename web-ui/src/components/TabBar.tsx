import { useServeStore } from "../store/serve"
import { wsClient } from "../ws/client"
import styles from "./TabBar.module.css"

export function TabBar() {
  const tabs = useServeStore((s) => s.tabs)
  const activeTabId = useServeStore((s) => s.activeTabId)

  if (tabs.length === 0) return null

  function switchTo(tabId: string) {
    useServeStore.getState().setActiveTab(tabId)
    wsClient.send({ type: "select.tab", tabId })
  }

  function abortRun(tabId: string, goalText: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (confirm(`Abort run: "${goalText.slice(0, 40)}"?`)) {
      wsClient.send({ type: "abort.run", tabId })
    }
  }

  return (
    <div className={`${styles.bar} ${tabs.length > 0 ? styles.visible : ""}`}>
      <button className={styles.newRunBtn} onClick={() => useServeStore.getState().setActiveTab(null)}>
        + New Run
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.tabId}
          className={`${styles.tab} ${tab.tabId === activeTabId ? styles.active : ""}`}
          title={tab.goalText}
          onClick={() => switchTo(tab.tabId)}
        >
          <span className={`${styles.dot} ${styles[tab.status] ?? ""}`} />
          <span>{tab.tabId.startsWith("replay-") ? "🔁 " : ""}{tab.goalText.slice(0, 28)}{tab.goalText.length > 28 ? "…" : ""}</span>
          <span
            className={styles.close}
            onClick={(e) => abortRun(tab.tabId, tab.goalText, e)}
            title="Abort run"
          >✕</span>
        </div>
      ))}
    </div>
  )
}
