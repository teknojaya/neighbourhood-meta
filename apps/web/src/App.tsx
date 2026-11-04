import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { RedirectIfSignedIn, RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { FullScreenMessage } from './components/ui';
import { ActivityPage } from './features/activity/ActivityPage';
import { LoginPage } from './features/auth/AuthPages';
import { CommunitiesPage } from './features/communities/CommunitiesPage';
import { HomePage } from './features/home/HomePage';
import { ExplorePage } from './features/listings/ExplorePage';
import { ProductCategoriesPage } from './features/categories/ProductCategoriesPage';
import { ListingDetailPage } from './features/listings/ListingDetailPage';
import { SharePage } from './features/listings/SharePage';
import { SavedItemsPage } from './features/listings/SavedItemsPage';
import { MessagesPage } from './features/messages/MessagesPage';
import { AskPage } from './features/ask/AskPage';
import { EventsPage } from './features/events/EventsPage';
import { CreateEventPage } from './features/events/CreateEventPage';
import { EventDetailPage } from './features/events/EventDetailPage';
import { SavedNeedsPage } from './features/needs/SavedNeedsPage';
import { NotificationsPage } from './features/notifications/NotificationsPage';
import { ProfilePage } from './features/profile/ProfilePage';
import { t } from './i18n';
import { firebaseConfigured } from './lib/firebase';

const router = createBrowserRouter([
  {
    element: <RedirectIfSignedIn />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <Navigate to="/login" replace /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'needs', element: <AskPage /> },
          { path: 'needs/saved', element: <SavedNeedsPage /> },
          { path: 'explore', element: <ExplorePage /> },
          { path: 'listings/:id', element: <ListingDetailPage /> },
          { path: 'share', element: <SharePage /> },
          { path: 'saved-items', element: <SavedItemsPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'communities', element: <CommunitiesPage /> },
          { path: 'events', element: <EventsPage /> },
          { path: 'events/new', element: <CreateEventPage /> },
          { path: 'events/:id', element: <EventDetailPage /> },
          { path: 'messages', element: <MessagesPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'categories', element: <ProductCategoriesPage /> },
          { path: 'profile', element: <ProfilePage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function App() {
  if (!firebaseConfigured) return <FullScreenMessage title={t('config.missingTitle')} body={t('config.missingBody')} />;
  return <RouterProvider router={router} />;
}
