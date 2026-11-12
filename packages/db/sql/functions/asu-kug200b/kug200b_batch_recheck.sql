CREATE OR REPLACE FUNCTION public.kug200b_batch_recheck(p_batch public.kug200b_batch, p_channel public.kug200b_batch_channel, p_artifact public.kug200b_batch_artifact, p_outdated_versions text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  m public.kug200b_batch_member;
  r public.participation;
  d public.document;
  v_problem text;
  v_rows jsonb := '[]';
BEGIN
  PERFORM FROM public.participation p
  WHERE p.id IN (SELECT participation_id FROM public.kug200b_batch_member
                 WHERE batch_id = p_batch.id)
  ORDER BY p.id FOR UPDATE;
  PERFORM FROM public.document x
  WHERE x.id IN (SELECT document_id FROM public.kug200b_batch_member WHERE batch_id = p_batch.id)
  ORDER BY x.id FOR SHARE;
  IF p_channel IS DISTINCT FROM p_batch.channel OR p_artifact IS DISTINCT FROM p_batch.artifact THEN
    RETURN pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('participationId', NULL,
      'documentId', NULL, 'reason', 'settings_changed'));
  END IF;
  FOR m IN SELECT * FROM public.kug200b_batch_member WHERE batch_id = p_batch.id
           ORDER BY participation_id LOOP
    SELECT * INTO r FROM public.participation WHERE id = m.participation_id;
    SELECT * INTO d FROM public.document WHERE id = m.document_id;
    v_problem := public.kug200b_member_problem(r, d, p_batch.agentur_key,
      coalesce(p_outdated_versions, '{}'), m);
    IF v_problem IS NOT NULL THEN
      v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'participationId', m.participation_id, 'documentId', m.document_id, 'reason', v_problem));
    END IF;
  END LOOP;
  RETURN v_rows;
END $function$;

ALTER FUNCTION public.kug200b_batch_recheck(public.kug200b_batch,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) OWNER TO transfer_owner;
REVOKE ALL ON FUNCTION public.kug200b_batch_recheck(public.kug200b_batch,public.kug200b_batch_channel,public.kug200b_batch_artifact,text[]) FROM PUBLIC;
