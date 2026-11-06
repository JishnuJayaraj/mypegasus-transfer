import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext, useRouterState } from "@tanstack/react-router";
import { Button, HeaderPanelAction, Logout, Translate, UserAvatar } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { languages } from "../i18n";
import { meQuery, useLogout } from "../session";

/** The header's actions: the language switch, and the account menu while logged in. */
export function HeaderActions() {
  // No account menu where nobody is logged in yet: the public notice makes no API request at all
  // (it carries no participant context), login and activation start the session.
  const withAccount = useRouterState({
    select: (s) => !/^\/(notice\/|login|activate)/.test(s.location.pathname),
  });
  const { api } = useRouteContext({ from: "__root__" });
  const me = useQuery({ ...meQuery(api), enabled: withAccount });
  return (
    <>
      <LanguageMenu />
      {withAccount && me.data && <AccountMenu firstName={me.data.firstName} />}
    </>
  );
}

/** The portal's language switch (de/en in the MVP), each language named in itself. */
function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage === "en" ? "en" : "de";
  return (
    <HeaderPanelAction
      label={t("language.menu", { language: languages[current] })}
      icon={<Translate size={20} />}
    >
      {(close) => (
        <ul className="tp-language-list">
          {Object.entries(languages).map(([code, name]) => (
            <li key={code}>
              <Button
                kind="ghost"
                lang={code}
                aria-pressed={code === current}
                onClick={() => {
                  void i18n.changeLanguage(code);
                  close();
                }}
              >
                {name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </HeaderPanelAction>
  );
}

/** "Mein Konto" and "Abmelden". */
function AccountMenu({ firstName }: { firstName: string }) {
  const { t } = useTranslation();
  const logout = useLogout();
  return (
    <HeaderPanelAction label={t("account.menu")} icon={<UserAvatar size={20} />}>
      {(close) => (
        <>
          <p className="tp-user-name">{firstName}</p>
          <Link
            to="/account"
            className="tp-header-panel-link"
            onClick={() => close({ returnFocus: false })}
          >
            {t("account.title")}
          </Link>
          <Button kind="secondary" renderIcon={Logout} onClick={() => void logout()}>
            {t("account.logout")}
          </Button>
        </>
      )}
    </HeaderPanelAction>
  );
}
