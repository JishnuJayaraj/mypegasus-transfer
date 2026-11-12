CREATE OR REPLACE TRIGGER participant_profile_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.participant_profile FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
