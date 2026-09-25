const { sphereGraph, sphereDetail } = require('../services/sphere');
function registerSphere(app, db, requireOrgContext) {
  app.get('/api/sphere', requireOrgContext, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await sphereGraph(db, req.orgId, req.canAccessEntity));
  });
  app.get('/api/sphere/record/:type/:id', requireOrgContext, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await sphereDetail(db, req.orgId, req.canAccessEntity, req.params.type, req.params.id));
  });
}
module.exports = { registerSphere };
