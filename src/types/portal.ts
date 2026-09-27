export type ServiceKey='patient_experience'|'external_referrals';
export type PortalRole='management'|'staff'|'custom';
export interface Profile { id:string; name:string; email:string|null; role:PortalRole; department_id:string|null; must_change_password:boolean; is_active:boolean; }
export interface ServiceAccess { service_key:ServiceKey; can_view:boolean; can_create:boolean; can_edit:boolean; can_manage:boolean; }
