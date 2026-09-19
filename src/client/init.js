
// --- Init ---
// Wait for auth check before loading the default view. Superadmins without an
// active org context see the MSP portal instead. Non-superadmin users land on
// the first view they have permission for (mission-control if 'org' is allowed).
const uiReady = document.readyState === 'loading'
  ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once:true}))
  : Promise.resolve();
Promise.all([userReady,uiReady]).then(([showingMSP]) => {
  if (showingMSP) return;
  initializeExperience();
  if (hasPermissionForView('mission-control')) {
    loadMissionControl();
  }
  // If mission-control is not permitted, applyModulePermissions() in
  // loadCurrentUser already navigated to the first accessible view.
});
