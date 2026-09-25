
// --- Init ---
// Wait for auth check before loading the default view. Superadmins without an
// active org context see the MSP portal instead. Non-superadmin users land on
// Sphere when Mission Control is permitted, otherwise My Tasks.
const uiReady = document.readyState === 'loading'
  ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once:true}))
  : Promise.resolve();
Promise.all([userReady,uiReady]).then(([showingMSP]) => {
  if (showingMSP) return;
  initializeExperience();
  switchView(hasPermissionForView('mission-control') ? 'mission-control' : 'my-tasks').catch(error => showToast(error.message, 'error'));
});
