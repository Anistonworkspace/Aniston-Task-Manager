import React, { useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import DetailModalShell from '../common/DetailModalShell';
import ProfilePage from '../../pages/ProfilePage';

/**
 * ProfileModalRoute — overlay wrapper for the user profile, rendered on top
 * of whatever page the user was on when they clicked "My Profile".
 *
 * The Header dropdown navigates to `/profile` with `state: { background: location }`
 * (see App.jsx for the routing pattern). When that state is present, App
 * renders THIS component above the existing page so the prior screen stays
 * visible behind the dim/blur backdrop. Closing the modal pops history back
 * to the background route.
 *
 * Visual + interaction parity with TaskModal is achieved by reusing the
 * exact same DetailModalShell with `size="sheet" placement="bottom-sheet"` —
 * identical slide-up animation, backdrop, focus trap, ESC handling, click-
 * outside dismissal, scroll lock, and z-[100] layering.
 */
export default function ProfileModalRoute() {
  const navigate = useNavigate();
  const location = useLocation();

  // Ref the shell populates with its animated `requestClose`. Calling it
  // plays the slide-down exit before the parent unmounts the modal — same
  // pattern TaskModal uses for its X button.
  const shellCloseRef = useRef(null);

  // When the modal was opened from another page (state.background set),
  // closing should pop history so the user returns to that page. On a direct
  // /profile visit (refresh, deep link), there's no background to return to,
  // so we navigate home — never strand the user on a blank backdrop.
  const handleClose = useCallback(() => {
    if (location.state?.background) navigate(-1);
    else navigate('/', { replace: true });
  }, [navigate, location.state]);

  // The X inside ProfilePage triggers requestClose so the slide-down plays
  // first; if the ref isn't wired yet (very early click), fall back to
  // direct close.
  const requestClose = useCallback(() => {
    if (shellCloseRef.current) shellCloseRef.current();
    else handleClose();
  }, [handleClose]);

  return (
    <DetailModalShell
      onClose={handleClose}
      closeRef={shellCloseRef}
      ariaLabel="Profile"
      size="sheet"
      placement="bottom-sheet"
    >
      <ProfilePage variant="modal" onClose={requestClose} />
    </DetailModalShell>
  );
}
