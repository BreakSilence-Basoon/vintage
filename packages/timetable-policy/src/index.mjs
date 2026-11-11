// This function is a policy decision, not an authentication or database layer.
// The server must establish the actor and load the resource independently of
// client-supplied claims before calling it. Unknown or incomplete inputs deny.
const validId = (value) => typeof value === 'string' && value.length > 0 && value === value.trim();

export function mayAccessTimetable(input) {
  if (!input || typeof input !== 'object') return false;
  const { actor, resource, action } = input;
  if (!actor || !resource || actor.active !== true) return false;
  if (!validId(actor.businessId) || !validId(actor.staffId) || !validId(resource.businessId)) return false;
  if (actor.businessId !== resource.businessId) return false;
  if (actor.role !== 'ADMIN' && actor.role !== 'VIEWER') return false;

  switch (action) {
    case 'schedule:read':
      return true;
    case 'history:read':
      return validId(resource.staffId) && (actor.role === 'ADMIN' || actor.staffId === resource.staffId);
    case 'schedule:write':
    case 'attendance:adjust':
      return actor.role === 'ADMIN';
    default:
      return false;
  }
}
