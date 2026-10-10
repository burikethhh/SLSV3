-- Existing deployments may already have applied 0009 before the is_trial
-- column-level grant was added there. Keep raw_token inaccessible to browsers.
grant select (is_trial) on licenses to authenticated;
