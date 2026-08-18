import { HashRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { TaskDetail } from './pages/TaskDetail'
import { Schedule } from './pages/Schedule'
import { DecisionCenter } from './pages/DecisionCenter'
import { DecisionFormPage } from './pages/DecisionFormPage'
import { DecisionExportPage } from './pages/DecisionExportPage'

// 部署在 GitHub Pages 子路径（/work-dashboard/）下：
// BrowserRouter 在子路径下直接刷新 /task/:id 会 404（Pages 无 SPA fallback），
// 因此使用 HashRouter（URL 形如 /work-dashboard/#/task/:id），刷新永不 404，最稳妥。
export default function App() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/task/:id" element={<TaskDetail />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/decisions" element={<DecisionCenter />} />
          <Route path="/decisions/:slug" element={<DecisionFormPage />} />
          <Route path="/decisions/:slug/export" element={<DecisionExportPage />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </Layout>
    </HashRouter>
  )
}
