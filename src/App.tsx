import { lazy, Suspense } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { CursorPresence } from './components/CursorPresence'
import { Layout } from './components/Layout'

// Keep the shell and navigation in the first request; load each work surface
// only when it is opened. This keeps the paper-style shell responsive without
// making the dashboard pay for Decision Center and export code up front.
const Dashboard = lazy(() => import('./pages/Dashboard').then(({ Dashboard: page }) => ({ default: page })))
const TaskDetail = lazy(() => import('./pages/TaskDetail').then(({ TaskDetail: page }) => ({ default: page })))
const Schedule = lazy(() => import('./pages/Schedule').then(({ Schedule: page }) => ({ default: page })))
const DecisionCenter = lazy(() => import('./pages/DecisionCenter').then(({ DecisionCenter: page }) => ({ default: page })))
const DecisionFormPage = lazy(() => import('./pages/DecisionFormPage').then(({ DecisionFormPage: page }) => ({ default: page })))
const DecisionExportPage = lazy(() => import('./pages/DecisionExportPage').then(({ DecisionExportPage: page }) => ({ default: page })))
const FeedbackInbox = lazy(() => import('./pages/FeedbackInbox').then(({ FeedbackInbox: page }) => ({ default: page })))

function RouteLoading() {
  return (
    <div className="page route-loading" aria-label="页面加载中">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-panel" />
    </div>
  )
}

// 部署在 GitHub Pages 子路径（/work-dashboard/）下：
// BrowserRouter 在子路径下直接刷新 /task/:id 会 404（Pages 无 SPA fallback），
// 因此使用 HashRouter（URL 形如 /work-dashboard/#/task/:id），刷新永不 404，最稳妥。
export default function App() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <CursorPresence />
      <Layout>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/task/:id" element={<TaskDetail />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/decisions" element={<DecisionCenter />} />
            <Route path="/decisions/:slug" element={<DecisionFormPage />} />
            <Route path="/decisions/:slug/export" element={<DecisionExportPage />} />
            <Route path="/inbox" element={<FeedbackInbox />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </Suspense>
      </Layout>
    </HashRouter>
  )
}
