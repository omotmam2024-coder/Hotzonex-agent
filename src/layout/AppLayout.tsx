import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useBusiness } from '../business/BusinessContext';

const NAV = [
  { to: '/products', label: 'Products' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  const { client, session } = useAuth();
  const { me, current, select } = useBusiness();

  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">Hotzonex Agent</strong>
        {me.memberships.length > 1 ? (
          <label className="business-picker">
            <span className="sr-only">Business</span>
            <select value={current.business_id} onChange={(e) => select(e.target.value)}>
              {me.memberships.map((m) => (
                <option key={m.business_id} value={m.business_id}>
                  {m.business_name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="business-name">{current.business_name}</span>
        )}
        <span className="spacer" />
        <span className="muted user-email">{session?.email}</span>
        <button type="button" className="btn btn--ghost" onClick={() => void client.signOut()}>
          Sign out
        </button>
      </header>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'nav__link nav__link--active' : 'nav__link')}>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
