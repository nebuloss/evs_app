import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import QueryPage from './pages/QueryPage'
import SettingsPage from './pages/SettingsPage'
import AccountPage from './pages/AccountPage'
import WishlistPage from './pages/WishlistPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/query" replace />} />
        <Route path="query" element={<QueryPage />} />
        <Route path="wishlist" element={<WishlistPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
