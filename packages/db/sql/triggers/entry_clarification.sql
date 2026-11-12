CREATE OR REPLACE TRIGGER entry_clarification_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.entry_clarification FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
