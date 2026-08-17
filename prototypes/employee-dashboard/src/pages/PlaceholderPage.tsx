import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

interface PlaceholderPageProps {
  title: string;
  description: string;
}

// Full Book-a-Room / My-Reservations / Manage-Rooms screens are the rest of
// Module 1 (see Technical Design §5 for the endpoints they call) and are out
// of scope for this home-screen build. These stand in so every link from the
// dashboard and sidebar leads somewhere real.
export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div>
      <h1 className="wh-page-title">{title}</h1>
      <p className="wh-page-subtitle">{description}</p>
      <div className="wh-portlet" style={{ marginTop: 24, alignItems: 'center', padding: 40 }}>
        <div className="wh-portlet__empty" style={{ padding: 0 }}>
          <Icon name="sparkles" size={22} />
          <div style={{ marginTop: 12 }}>This screen is built as part of Module 1's full booking flow.</div>
          <Link to="/" className="wh-portlet__link" style={{ display: 'inline-block', marginTop: 12 }}>
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
