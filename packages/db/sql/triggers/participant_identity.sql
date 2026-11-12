CREATE OR REPLACE TRIGGER participant_identity_evidence_set_phase BEFORE INSERT OR DELETE OR UPDATE ON public.participant_identity FOR EACH ROW EXECUTE FUNCTION public.refuse_in_evidence_set_phase();
