import { HashRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { TaskDetail } from './pages/TaskDetail'

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
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </Layout>
    </HashRouter>
  )
}
