import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import {
  acceptProjectInvitation,
  createProjectInvitation,
  listIncomingProjectInvitations,
  listProjectInvitations,
  listProjectMembers,
  removeProjectMember,
  revokeProjectInvitation,
  sendProjectInvitationEmail,
  updateProjectInvitationRole,
  updateProjectMemberRole,
  type ProjectInvitation,
  type ProjectInvitationRole,
  type ProjectMember,
  type ProjectMemberRole,
} from "../services/projectCollaboration";
import { Modal } from "./Modal";
import type { ActivityActionType } from "../types";
import { subscriptionErrorCode, subscriptionErrorMessage } from "../services/subscriptionService";
import { formatDateForDisplay } from "../utils/dateHelpers";

interface ProjectTeamModalProps {
  account: SupabaseAccount;
  workspace: SupabaseWorkspace | null;
  onClose: () => void;
  onInvitationAccepted: (projectId: string) => Promise<void>;
  canInviteEditor?: boolean;
  onUpgradeRequired?: () => void;
  onSubscriptionChanged?: () => void;
  onActivity?: (
    relatedId: string,
    text: string,
    actionType: ActivityActionType,
  ) => void;
}

function roleLabel(role: ProjectMemberRole): string {
  if (role === "owner") return "Власник";
  if (role === "editor") return "Редактор";
  return "Лише перегляд";
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = String(error.message ?? "");
    if (message.includes("project_invitations_pending_unique")) {
      return "Для цієї адреси вже є активне запрошення.";
    }
    if (message) return message;
  }
  return fallback;
}

export function ProjectTeamModal({
  account,
  workspace,
  onClose,
  onInvitationAccepted,
  canInviteEditor = true,
  onUpgradeRequired,
  onSubscriptionChanged,
  onActivity,
}: ProjectTeamModalProps) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [sentInvitations, setSentInvitations] = useState<ProjectInvitation[]>([]);
  const [incomingInvitations, setIncomingInvitations] = useState<ProjectInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectInvitationRole>("editor");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isOwner = workspace?.role === "owner";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextMembers, nextSent, nextIncoming] = await Promise.all([
        workspace ? listProjectMembers(workspace.projectId) : Promise.resolve([]),
        workspace && isOwner
          ? listProjectInvitations(workspace.projectId)
          : Promise.resolve([]),
        listIncomingProjectInvitations(),
      ]);
      setMembers(nextMembers);
      setSentInvitations(nextSent);
      setIncomingInvitations(nextIncoming);
    } catch (loadError) {
      setError(describeError(loadError, "Не вдалося завантажити учасників проєкту."));
    } finally {
      setLoading(false);
    }
  }, [isOwner, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace) return;
    setBusyId("invite");
    setError("");
    setNotice("");
    try {
      const result = await createProjectInvitation(workspace.projectId, email, role);
      setSentInvitations((current) => [result.invitation, ...current]);
      onActivity?.(
        result.invitation.id,
        `Створено запрошення для ${result.invitation.email} з роллю «${roleLabel(result.invitation.role)}».`,
        "invitation_created",
      );
      setEmail("");
      setNotice(
        result.emailSent
          ? "Запрошення створено, лист надіслано."
          : result.warning ?? "Запрошення створено без надсилання листа.",
      );
      onSubscriptionChanged?.();
    } catch (inviteError) {
      if (subscriptionErrorCode(inviteError) === "PLAN_LIMIT_REACHED:editors_total") {
        onUpgradeRequired?.();
      }
      setError(subscriptionErrorMessage(inviteError) || describeError(inviteError, "Не вдалося створити запрошення."));
    } finally {
      setBusyId("");
    }
  };

  const changeMemberRole = async (
    member: ProjectMember,
    nextRole: ProjectInvitationRole,
  ) => {
    if (!workspace) return;
    setBusyId(member.userId);
    setError("");
    try {
      await updateProjectMemberRole(workspace.projectId, member.userId, nextRole);
      setMembers((current) =>
        current.map((item) =>
          item.userId === member.userId ? { ...item, role: nextRole } : item
        ),
      );
      onActivity?.(
        member.userId,
        `Змінено роль учасника ${member.displayName} на «${roleLabel(nextRole)}».`,
        "member_updated",
      );
      onSubscriptionChanged?.();
    } catch (updateError) {
      if (subscriptionErrorCode(updateError) === "PLAN_LIMIT_REACHED:editors_total") {
        onUpgradeRequired?.();
      }
      setError(subscriptionErrorMessage(updateError) || describeError(updateError, "Не вдалося змінити роль учасника."));
    } finally {
      setBusyId("");
    }
  };

  const removeMember = async (member: ProjectMember) => {
    if (!workspace) return;
    if (!window.confirm(`Видалити ${member.displayName} з проєкту?`)) return;
    setBusyId(member.userId);
    setError("");
    try {
      await removeProjectMember(workspace.projectId, member.userId);
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      onActivity?.(
        member.userId,
        `Видалено учасника ${member.displayName} з проєкту.`,
        "member_deleted",
      );
      onSubscriptionChanged?.();
    } catch (removeError) {
      setError(describeError(removeError, "Не вдалося видалити учасника."));
    } finally {
      setBusyId("");
    }
  };

  const changeInvitationRole = async (
    invitation: ProjectInvitation,
    nextRole: ProjectInvitationRole,
  ) => {
    setBusyId(invitation.id);
    setError("");
    try {
      await updateProjectInvitationRole(invitation.id, nextRole);
      setSentInvitations((current) =>
        current.map((item) =>
          item.id === invitation.id ? { ...item, role: nextRole } : item
        ),
      );
      onActivity?.(
        invitation.id,
        `Змінено роль у запрошенні для ${invitation.email} на «${roleLabel(nextRole)}».`,
        "invitation_updated",
      );
      onSubscriptionChanged?.();
    } catch (updateError) {
      if (subscriptionErrorCode(updateError) === "PLAN_LIMIT_REACHED:editors_total") {
        onUpgradeRequired?.();
      }
      setError(subscriptionErrorMessage(updateError) || describeError(updateError, "Не вдалося змінити роль у запрошенні."));
    } finally {
      setBusyId("");
    }
  };

  const revokeInvitation = async (invitation: ProjectInvitation) => {
    setBusyId(invitation.id);
    setError("");
    try {
      await revokeProjectInvitation(invitation.id);
      setSentInvitations((current) =>
        current.filter((item) => item.id !== invitation.id),
      );
      onActivity?.(
        invitation.id,
        `Скасовано запрошення для ${invitation.email}.`,
        "invitation_deleted",
      );
      onSubscriptionChanged?.();
    } catch (revokeError) {
      setError(describeError(revokeError, "Не вдалося скасувати запрошення."));
    } finally {
      setBusyId("");
    }
  };

  const resendInvitation = async (invitation: ProjectInvitation) => {
    setBusyId(invitation.id);
    setError("");
    setNotice("");
    try {
      await sendProjectInvitationEmail(invitation.id);
      onActivity?.(
        invitation.id,
        `Повторно надіслано запрошення для ${invitation.email}.`,
        "invitation_updated",
      );
      setNotice(`Лист повторно надіслано на ${invitation.email}.`);
    } catch (sendError) {
      setError(describeError(sendError, "Не вдалося повторно надіслати лист."));
    } finally {
      setBusyId("");
    }
  };

  const acceptInvitation = async (invitation: ProjectInvitation) => {
    setBusyId(invitation.id);
    setError("");
    try {
      const projectId = await acceptProjectInvitation(invitation.id);
      setIncomingInvitations((current) =>
        current.filter((item) => item.id !== invitation.id),
      );
      await onInvitationAccepted(projectId);
    } catch (acceptError) {
      setError(describeError(acceptError, "Не вдалося прийняти запрошення."));
    } finally {
      setBusyId("");
    }
  };

  return (
    <Modal title="Учасники та запрошення" onClose={onClose}>
      <div className="team-modal">
        <div className="team-account-note">
          Запрошення для вашого облікового запису: <strong>{account.email}</strong>
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {notice ? <div className="alert alert-notice">{notice}</div> : null}

        {incomingInvitations.length ? (
          <section className="team-section">
            <div className="section-heading">
              <div>
                <h3>Вхідні запрошення</h3>
                <p>Після прийняття проєкт з'явиться у списку ваших проєктів.</p>
              </div>
            </div>
            <div className="team-list">
              {incomingInvitations.map((invitation) => (
                <article className="team-row" key={invitation.id}>
                  <div>
                    <strong>{invitation.projectName}</strong>
                    <small>{roleLabel(invitation.role)}</small>
                  </div>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={Boolean(busyId)}
                    onClick={() => void acceptInvitation(invitation)}
                  >
                    {busyId === invitation.id ? "Прийняття…" : "Прийняти"}
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {workspace ? (
          <section className="team-section">
            <div className="section-heading">
              <div>
                <h3>{workspace.projectName}</h3>
                <p>Учасники бачать тільки ті проєкти, до яких їм надано доступ.</p>
              </div>
            </div>

            {isOwner ? (
              <form className="team-invite-form" onSubmit={invite}>
                <label>
                  <span>Електронна адреса</span>
                  <input
                    type="email"
                    required
                    value={email}
                    placeholder="name@example.com"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <label>
                  <span>Права доступу</span>
                  <select
                    value={role}
                    onChange={(event) =>
                      setRole(event.target.value as ProjectInvitationRole)
                    }
                  >
                    <option value="editor">Може редагувати</option>
                    <option value="viewer">Лише перегляд</option>
                  </select>
                </label>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={Boolean(busyId)}
                >
                  {busyId === "invite" ? "Створення…" : "Запросити"}
                </button>
                {role === "editor" && !canInviteEditor ? (
                  <small>Новий редактор потребуватиме вільного редакторського місця. Уже врахований редактор місце повторно не займає.</small>
                ) : null}
              </form>
            ) : null}

            <div className="team-list">
              {loading ? <div className="empty-inline">Завантаження учасників…</div> : null}
              {!loading && members.map((member) => (
                <article className="team-row" key={member.userId}>
                  <div className="team-member">
                    {member.avatarUrl ? (
                      <img src={member.avatarUrl} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span>{member.displayName.slice(0, 1).toUpperCase()}</span>
                    )}
                    <div>
                      <strong>{member.displayName}</strong>
                      <small>{member.email}</small>
                    </div>
                  </div>
                  {isOwner && member.role !== "owner" ? (
                    <div className="team-row-actions">
                      <select
                        aria-label={`Роль ${member.displayName}`}
                        value={member.role}
                        disabled={Boolean(busyId)}
                        onChange={(event) =>
                          void changeMemberRole(
                            member,
                            event.target.value as ProjectInvitationRole,
                          )
                        }
                      >
                        <option value="editor">Редактор</option>
                        <option value="viewer">Лише перегляд</option>
                      </select>
                      <button
                        type="button"
                        className="icon-button danger"
                        title="Видалити учасника"
                        disabled={Boolean(busyId)}
                        onClick={() => void removeMember(member)}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <span className="team-role">{roleLabel(member.role)}</span>
                  )}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {isOwner && sentInvitations.length ? (
          <section className="team-section">
            <div className="section-heading">
              <div>
                <h3>Очікують прийняття</h3>
                <p>Запрошення діє 14 днів.</p>
              </div>
            </div>
            <div className="team-list">
              {sentInvitations.map((invitation) => (
                <article className="team-row" key={invitation.id}>
                  <div>
                    <strong>{invitation.email}</strong>
                    <small>
                      До {formatDateForDisplay(invitation.expiresAt)}
                    </small>
                  </div>
                  <div className="team-row-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={Boolean(busyId)}
                      onClick={() => void resendInvitation(invitation)}
                    >
                      {busyId === invitation.id ? "Надсилання…" : "Надіслати лист"}
                    </button>
                    <select
                      value={invitation.role}
                      disabled={Boolean(busyId)}
                      onChange={(event) =>
                        void changeInvitationRole(
                          invitation,
                          event.target.value as ProjectInvitationRole,
                        )
                      }
                    >
                      <option value="editor">Редактор</option>
                      <option value="viewer">Лише перегляд</option>
                    </select>
                    <button
                      type="button"
                      className="text-button danger-text"
                      disabled={Boolean(busyId)}
                      onClick={() => void revokeInvitation(invitation)}
                    >
                      Скасувати
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Закрити
          </button>
        </div>
      </div>
    </Modal>
  );
}
